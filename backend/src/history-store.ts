import {mkdir,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {HttpError} from './errors.js';

const uuid=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const dayFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'});
export const historyDay=(at:number)=>dayFormat.format(at);
function fail(message='Dữ liệu lịch sử không hợp lệ.'):never{throw new HttpError(400,message);}
function id(value:unknown):string{if(typeof value!=='string'||!uuid.test(value))return fail();return value.toLowerCase();}
function timestamp(value:unknown):number{if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>8640000000000000)return fail();return value;}
function text(value:unknown,max=120):string{if(typeof value!=='string'||!value.trim()||value.length>max)return fail();return value.trim();}
function integer(value:unknown,min=1):number{if(!Number.isSafeInteger(value)||Number(value)<min)return fail();return Number(value);}
function date(value:string){const parsed=new Date(value+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)fail();return value;}

export interface HistoryCapture {
  captureId:string;trackId:string;displayName:string;labels:string[];count:number;
  firstAt:number;lastAt:number;revision:number;photoAt?:number;photoBeforeAlert?:boolean;photoRevision?:number;
}
export interface HistoryRun {
  id:string;date:string;number:number;startedAt:number;endedAt?:number;
  source:'pi'|'webcam';cameraLabel:string;captures:HistoryCapture[];
}
interface Day {version:1;date:string;nextRunNumber:number;runs:HistoryRun[];deletedRunIds:string[]}
export interface CaptureUpdate extends HistoryCapture {photo?:string}
const summary=(run:HistoryRun)=>({id:run.id,date:run.date,number:run.number,startedAt:run.startedAt,endedAt:run.endedAt,
  source:run.source,cameraLabel:run.cameraLabel,peopleCount:run.captures.length,eventCount:run.captures.reduce((n,c)=>n+c.count,0)});
const publicCapture=(run:HistoryRun,capture:HistoryCapture)=>({...capture,
  ...(capture.photoRevision?{photoUrl:`/api/history/runs/${run.id}/captures/${capture.captureId}/photo?v=${capture.photoRevision}`}:{})});

/** A single writer makes JSON replacement and deletion ordered, including retries. */
export class HistoryStore {
  private days=new Map<string,Day>();
  private runDays=new Map<string,string>();
  private deleted=new Set<string>();
  private initialization?:Promise<void>;
  private queue:Promise<unknown>=Promise.resolve();
  readonly root:string;
  constructor(root:string,private now=()=>Date.now()){this.root=resolve(root);}
  private init(){return this.initialization??=(async()=>{
    await mkdir(this.root,{recursive:true});
    for(const entry of await readdir(this.root,{withFileTypes:true})){
      if(!entry.isDirectory()||!/^\d{4}-\d{2}-\d{2}$/.test(entry.name))continue;
      let day:Day;
      try{day=JSON.parse(await readFile(join(this.root,entry.name,'history.json'),'utf8'));}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      if(day.version!==1||day.date!==entry.name||!Array.isArray(day.runs)||!Number.isSafeInteger(day.nextRunNumber))
        throw new Error('Không đọc được lịch sử ngày '+entry.name);
      day.deletedRunIds??=[];
      this.days.set(day.date,day);
      for(const run of day.runs){id(run.id);if(run.date!==day.date)throw new Error('Ngày lịch sử không hợp lệ.');this.runDays.set(run.id,day.date);}
      for(const removed of day.deletedRunIds)this.deleted.add(id(removed));
    }
  })().catch(error=>{this.initialization=undefined;this.days.clear();this.runDays.clear();this.deleted.clear();throw error;});}
  private write<T>(operation:()=>Promise<T>):Promise<T>{
    const result=this.queue.then(async()=>{await this.init();return operation();});
    this.queue=result.catch(()=>{});return result;
  }
  private async commit(day:Day){
    const folder=join(this.root,day.date);await mkdir(folder,{recursive:true});
    const temporary=join(folder,`history.${randomUUID()}.tmp`);
    try{await writeFile(temporary,JSON.stringify(day,null,2),'utf8');await rename(temporary,join(folder,'history.json'));}
    finally{await rm(temporary,{force:true});}
    this.days.set(day.date,day);
  }
  private find(runId:string){
    const key=id(runId),day=this.days.get(this.runDays.get(key)??'');
    const run=day?.runs.find(run=>run.id===key);
    if(!day||!run)throw new HttpError(this.deleted.has(key)?410:404,'Lần nhận diện không còn trong lịch sử.');
    return {day,run};
  }
  private async ready(){await this.init();await this.queue;}
  async listDays(){await this.ready();return [...this.days.values()].filter(day=>day.runs.length).map(day=>day.date).sort().reverse();}
  async listRuns(dayKey:string){await this.ready();return (this.days.get(date(dayKey))?.runs??[]).map(summary).sort((a,b)=>b.number-a.number);}
  async get(runId:string){await this.ready();const {run}=this.find(runId);return {...summary(run),captures:run.captures.map(c=>publicCapture(run,c)).sort((a,b)=>b.lastAt-a.lastAt)};}
  create(input:unknown){return this.write(async()=>{
    const value=input as Record<string,unknown>;if(!value||typeof value!=='object')fail();
    const runId=id(value.id);
    if(this.deleted.has(runId))throw new HttpError(410,'Lần nhận diện này đã bị xóa.');
    if(this.runDays.has(runId))return summary(this.find(runId).run);
    const startedAt=timestamp(value.startedAt??this.now()),dayKey=historyDay(startedAt);
    if(value.source!=='pi'&&value.source!=='webcam')fail();
    const day=structuredClone(this.days.get(dayKey)??{version:1,date:dayKey,nextRunNumber:1,runs:[],deletedRunIds:[]}) as Day;
    const run:HistoryRun={id:runId,date:dayKey,number:day.nextRunNumber++,startedAt,
      source:value.source as 'pi'|'webcam',cameraLabel:text(value.cameraLabel||'Camera',160),captures:[]};
    day.runs.push(run);await this.commit(day);this.runDays.set(runId,dayKey);return summary(run);
  });}
  end(runId:string,input:unknown){return this.write(async()=>{
    const {day,run}=this.find(runId),endedAt=timestamp((input as {endedAt?:number})?.endedAt??this.now());
    const next=structuredClone(day),target=next.runs.find(r=>r.id===run.id)!;
    target.endedAt=Math.max(run.startedAt,endedAt,run.endedAt??0);await this.commit(next);return summary(target);
  });}
  update(runId:string,input:unknown){return this.write(async()=>{
    const {day,run}=this.find(runId),values=(input as {captures?:unknown[]})?.captures;
    if(!Array.isArray(values)||values.length>40)fail();
    const next=structuredClone(day),target=next.runs.find(r=>r.id===run.id)!;
    const updates:{capture:HistoryCapture;photo?:Buffer}[]=[];
    for(const raw of values){
      const value=raw as Record<string,unknown>;if(!value||typeof value!=='object')fail();
      const captureId=id(value.captureId),revision=integer(value.revision);
      const previous=target.captures.find(c=>c.captureId===captureId);
      if(previous&&revision<=previous.revision)continue;
      const count=integer(value.count),firstAt=timestamp(value.firstAt),lastAt=timestamp(value.lastAt);
      if(firstAt>lastAt||previous&&count<previous.count)fail();
      if(!Array.isArray(value.labels)||value.labels.length>20)fail();
      const capture:HistoryCapture={captureId,trackId:text(value.trackId,60),displayName:text(value.displayName,60),
        labels:value.labels.map(label=>text(label)),count,firstAt:previous?.firstAt??firstAt,lastAt:Math.max(previous?.lastAt??0,lastAt),revision,
        photoAt:previous?.photoAt,photoBeforeAlert:previous?.photoRevision&&typeof value.photoBeforeAlert==='boolean'?value.photoBeforeAlert:previous?.photoBeforeAlert,photoRevision:previous?.photoRevision};
      let photo:Buffer|undefined;
      if(value.photo!==undefined){
        if(typeof value.photo!=='string'||value.photo.length>180000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.photo))fail('Ảnh lịch sử phải là JPEG hợp lệ.');
        const bytes=Buffer.from(value.photo.slice(value.photo.indexOf(',')+1),'base64');
        try{photo=await sharp(bytes,{limitInputPixels:262144}).resize(160,160,{fit:'cover'}).jpeg({quality:82}).toBuffer();}
        catch{fail('Không đọc được ảnh mặt trong lịch sử.');}
        capture.photoAt=timestamp(value.photoAt??lastAt);capture.photoBeforeAlert=value.photoBeforeAlert===true;capture.photoRevision=revision;
      }
      updates.push({capture,photo});
      if(previous)target.captures.splice(target.captures.indexOf(previous),1,capture);else target.captures.push(capture);
    }
    for(const {capture,photo}of updates){
      if(!photo)continue;
      const folder=join(this.root,day.date,run.id);await mkdir(folder,{recursive:true});
      const temporary=join(folder,`${capture.captureId}.${randomUUID()}.tmp`);
      try{await writeFile(temporary,photo);await rename(temporary,join(folder,capture.captureId+'.jpg'));}
      finally{await rm(temporary,{force:true});}
    }
    if(updates.length)await this.commit(next);
    return summary(target);
  });}
  async photo(runId:string,captureId:string){
    await this.ready();const {run}=this.find(runId),key=id(captureId);
    if(!run.captures.some(c=>c.captureId===key&&c.photoRevision))throw new HttpError(404,'Chưa có ảnh mặt.');
    try{return await readFile(join(this.root,run.date,run.id,key+'.jpg'));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new HttpError(404,'Chưa có ảnh mặt.');throw error;}
  }
  removeRun(runId:string){return this.write(async()=>{
    const {day,run}=this.find(runId),next=structuredClone(day);
    next.runs=next.runs.filter(r=>r.id!==run.id);next.deletedRunIds.push(run.id);
    await this.commit(next);this.runDays.delete(run.id);this.deleted.add(run.id);
    await rm(join(this.root,day.date,run.id),{recursive:true,force:true});
  });}
  removeDay(dayKey:string){return this.write(async()=>{
    const key=date(dayKey),day=this.days.get(key);if(!day)return;
    const next=structuredClone(day);next.deletedRunIds.push(...day.runs.map(r=>r.id));next.runs=[];
    await this.commit(next);
    for(const run of day.runs){this.runDays.delete(run.id);this.deleted.add(run.id);await rm(join(this.root,key,run.id),{recursive:true,force:true});}
  });}
  async close(){await this.queue;}
}
