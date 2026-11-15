import type {AttentionCapture} from './attention-captures';

export const vietnamDay=(at=Date.now())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
export interface HistoryRunSummary {id:string;date:string;number:number;startedAt:number;endedAt?:number;source:'pi'|'webcam';cameraLabel:string;peopleCount:number;eventCount:number}
export interface HistoryCapture {captureId:string;trackId:string;displayName:string;labels:string[];count:number;firstAt:number;lastAt:number;revision:number;photoAt?:number;photoBeforeAlert?:boolean;photoRevision?:number;photoUrl?:string}
export interface HistoryRun extends HistoryRunSummary {captures:HistoryCapture[]}
export interface HistoryState {date:string;days:string[];runs:HistoryRunSummary[];selectedId?:string;detail?:HistoryRun;activeId?:string;loading:boolean;error?:string;savingError?:string}
type Update=HistoryCapture&{photo?:string};
interface Job {run:HistoryRun;created:boolean;pending:Map<string,Update>;endedAt?:number;closed:boolean;holds:number;dropped?:boolean}

/** One coalesced outbox entry per changed person; inference never awaits disk IO. */
export class DetectionHistory {
  private state:HistoryState={date:vietnamDay(),days:[],runs:[],loading:false};
  private listeners=new Set<()=>void>();
  private jobs=new Map<string,Job>();
  private running=false;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private readVersion=0;
  private disposed=false;
  private notification:ReturnType<typeof setTimeout>|undefined;
  constructor(private request:typeof fetch=(...args)=>fetch(...args),private now=()=>Date.now()){}
  getSnapshot=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish(update:Partial<HistoryState>,defer=false){
    if(this.disposed)return;this.state={...this.state,...update};
    const notify=()=>{this.notification=undefined;this.listeners.forEach(f=>f());};
    if(defer){this.notification??=setTimeout(notify,50);}else{clearTimeout(this.notification);notify();}
  }
  private async api<T>(path:string,method='GET',data?:unknown):Promise<T>{
    const body=data===undefined?undefined:JSON.stringify(data);
    const response=await this.request('/api/history'+path,{method,body,
      ...(body?{headers:{'Content-Type':'application/json'},keepalive:body.length<60000}:{}),signal:AbortSignal.timeout(10000)});
    if(!response.ok){const detail=await response.json().catch(()=>({}));throw Object.assign(new Error(detail.error||'Không đọc được lịch sử.'),{status:response.status});}
    return response.status===204?undefined as T:response.json();
  }
  async load(date=this.state.date,selectedId?:string){
    const version=++this.readVersion;this.publish({date,loading:true,error:undefined,
      ...(date!==this.state.date?{runs:[],selectedId:undefined,detail:undefined}:{})});
    try{
      const [days,result]=await Promise.all([this.api<{days:string[]}>('/days'),this.api<{runs:HistoryRunSummary[]}>('/days/'+date)]);
      if(version!==this.readVersion)return;
      const local=[...this.jobs.values()].filter(j=>j.run.date===date&&!j.dropped&&!j.closed).map(j=>j.run);
      const runs=[...new Map([...result.runs,...local].map(run=>[run.id,run])).values()].sort((a,b)=>b.startedAt-a.startedAt);
      const selected=runs.find(r=>r.id===(selectedId??this.state.selectedId))?.id??runs[0]?.id;
      this.publish({days:days.days,runs,selectedId:selected,loading:false,detail:undefined});
      if(selected)await this.select(selected);
    }catch(error){if(version===this.readVersion)this.publish({loading:false,error:error instanceof Error?error.message:'Không tải được lịch sử.'});}
  }
  async select(runId:string){
    const job=this.jobs.get(runId),local=job&&!job.closed&&!job.dropped?job:undefined;
    this.publish({selectedId:runId,detail:local?.run,loading:!local,error:undefined});
    if(local)return;
    try{const detail=await this.api<HistoryRun>('/runs/'+runId);if(this.state.selectedId===runId)this.publish({detail,loading:false});}
    catch(error){if(this.state.selectedId===runId)this.publish({loading:false,error:error instanceof Error?error.message:'Không tải được lần nhận diện.'});}
  }
  toggle(runId:string){if(this.state.selectedId===runId){this.publish({selectedId:undefined,detail:undefined});}else void this.select(runId);}
  begin(source:'pi'|'webcam',cameraLabel:string){
    if(this.state.activeId)return this.state.activeId;
    const startedAt=this.now(),id=crypto.randomUUID(),date=vietnamDay(startedAt);
    const run:HistoryRun={id,date,startedAt,number:0,source,cameraLabel:cameraLabel||'Camera',peopleCount:0,eventCount:0,captures:[]};
    this.jobs.set(id,{run,created:false,pending:new Map(),closed:false,holds:0});
    ++this.readVersion;
    this.publish({date,activeId:id,selectedId:id,detail:run,loading:false,runs:[run,...this.state.runs.filter(r=>r.date===date)],
      days:[...new Set([date,...this.state.days])].sort().reverse(),error:undefined});
    this.schedule(0);return id;
  }
  enqueue(runId:string,entry:AttentionCapture){
    const job=this.jobs.get(runId);if(!job||job.dropped||!entry.captureId||!entry.revision)return;
    const update:Update={captureId:entry.captureId,trackId:entry.id,displayName:entry.displayName,labels:[...entry.labels],
      count:entry.count,firstAt:entry.firstAt,lastAt:entry.lastAt,revision:entry.revision,
      photo:entry.photo,photoAt:entry.photoAt,photoBeforeAlert:entry.photoBeforeAlert};
    const previous=job.pending.get(update.captureId);
    if(previous&&previous.revision>update.revision)return;
    if((job.run.captures.find(c=>c.captureId===update.captureId)?.revision??0)>=update.revision)return;
    job.pending.set(update.captureId,{...previous,...update,photo:update.photo??previous?.photo});
    const old=job.run.captures.find(c=>c.captureId===update.captureId);
    const item:HistoryCapture={...old,...update,photoUrl:update.photo??old?.photoUrl};
    delete (item as Partial<Update>).photo;
    if(old)job.run.captures.splice(job.run.captures.indexOf(old),1,item);else job.run.captures.push(item);
    this.refreshJob(job);this.schedule(250);
  }
  hold(runId:string){
    const job=this.jobs.get(runId);if(job)job.holds++;
    let released=false;return()=>{if(released)return;released=true;if(job)job.holds--;if(job?.endedAt!==undefined)this.schedule(0);};
  }
  end(){
    const job=this.jobs.get(this.state.activeId??'');if(!job)return;
    job.endedAt=this.now();job.run.endedAt=job.endedAt;
    this.publish({activeId:undefined});this.refreshJob(job);this.schedule(0);
  }
  private refreshJob(job:Job){
    if(job.dropped)return;
    job.run={...job.run,captures:[...job.run.captures].sort((a,b)=>b.lastAt-a.lastAt),peopleCount:job.run.captures.length,
      eventCount:job.run.captures.reduce((n,c)=>n+c.count,0)};
    if(job.run.date===this.state.date)this.publish({runs:[job.run,...this.state.runs.filter(r=>r.id!==job.run.id)].sort((a,b)=>b.startedAt-a.startedAt),
      ...(this.state.selectedId===job.run.id?{detail:job.run}:{})},true);
  }
  private schedule(delay:number){
    if(this.disposed||this.timer!==undefined)return;
    this.timer=setTimeout(()=>{this.timer=undefined;void this.flush();},delay);
  }
  async flush(){
    if(this.running||this.disposed)return;
    clearTimeout(this.timer);this.timer=undefined;this.running=true;
    let currentJob:Job|undefined,failed=false;
    try{
      for(const [id,job]of this.jobs){
        currentJob=job;
        if(job.dropped)continue;
        if(!job.created){
          const created=await this.api<HistoryRunSummary>('/runs','POST',{id,startedAt:job.run.startedAt,source:job.run.source,cameraLabel:job.run.cameraLabel});
          if(job.dropped)continue;
          if(typeof created.number!=='number')throw new Error('Phản hồi lịch sử không hợp lệ.');
          job.created=true;job.run={...job.run,...created,captures:job.run.captures};this.refreshJob(job);
        }
        while(job.pending.size){
          const batch=[...job.pending.values()].slice(0,20);
          await this.api('/runs/'+id+'/captures','PUT',{captures:batch});
          if(job.dropped)break;
          for(const update of batch){
            if(job.pending.get(update.captureId)?.revision!==update.revision)continue;
            job.pending.delete(update.captureId);
            const capture=job.run.captures.find(c=>c.captureId===update.captureId);
            if(capture&&update.photo){capture.photoRevision=update.revision;capture.photoUrl=`/api/history/runs/${id}/captures/${update.captureId}/photo?v=${update.revision}`;}
          }
          this.refreshJob(job);
        }
        if(!job.dropped&&job.endedAt!==undefined&&!job.closed&&!job.holds){
          await this.api('/runs/'+id,'PATCH',{endedAt:job.endedAt});job.closed=true;
        }
      }
      this.publish({savingError:undefined});
    }catch(error){
      failed=true;
      const status=(error as {status?:number})?.status;
      if(status===404||status===410){
        // A deleted run is never recreated by a late image or retry.
        if(currentJob){currentJob.dropped=true;currentJob.pending.clear();}
      }
      if(!currentJob||this.jobs.has(currentJob.run.id))this.publish({savingError:'Chưa lưu được lịch sử. '+(error instanceof Error?error.message:'Đang thử lại.')});
      if(status!==404&&status!==410)this.schedule(2000);
    }finally{this.running=false;if(!failed&&[...this.jobs.values()].some(j=>!j.dropped&&(!j.created||j.pending.size||j.endedAt!==undefined&&!j.closed&&!j.holds)))this.schedule(250);}
  }
  async removeRun(id:string){
    if(id===this.state.activeId)return;
    try{await this.api('/runs/'+id,'DELETE');const job=this.jobs.get(id);if(job){job.dropped=true;job.pending.clear();}this.jobs.delete(id);await this.load(this.state.date);}
    catch(error){this.publish({error:error instanceof Error?error.message:'Không xóa được lịch sử.'});}
  }
  async removeDay(date:string){
    if([...this.jobs.values()].some(j=>j.run.id===this.state.activeId&&j.run.date===date))return;
    try{await this.api('/days/'+date,'DELETE');for(const [id,j]of this.jobs)if(j.run.date===date){j.dropped=true;j.pending.clear();this.jobs.delete(id);}await this.load(date);}
    catch(error){this.publish({error:error instanceof Error?error.message:'Không xóa được lịch sử.'});}
  }
  dispose(){clearTimeout(this.timer);void this.flush().finally(()=>{this.disposed=true;clearTimeout(this.timer);clearTimeout(this.notification);this.listeners.clear();});}
}
