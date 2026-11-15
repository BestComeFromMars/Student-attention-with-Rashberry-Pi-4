import {afterEach,describe,it,expect,vi} from 'vitest';
import {DetectionHistory,vietnamDay} from './history';
import type {AttentionCapture} from './attention-captures';

const histories:DetectionHistory[]=[];
afterEach(()=>{histories.splice(0).forEach(h=>h.dispose());vi.useRealTimers();});
function setup(){
  vi.useFakeTimers();
  const requests:{path:string;method:string;body:any}[]=[],runs=new Map<string,any>();let offline=false,number=0;
  const fetcher=vi.fn(async(path:RequestInfo|URL,options?:RequestInit)=>{
    if(offline)throw new TypeError('offline');
    const url=String(path),method=options?.method??'GET',body=options?.body?JSON.parse(String(options.body)):undefined;
    requests.push({path:url,method,body});
    let value:any;
    if(url.endsWith('/days'))value={days:[vietnamDay()]};
    else if(url.includes('/days/'))value={runs:[...runs.values()]};
    else if(url.endsWith('/runs')&&method==='POST'){
      value=runs.get(body.id)??{...body,number:++number,date:vietnamDay(body.startedAt),peopleCount:0,eventCount:0,captures:[]};runs.set(body.id,value);
    }else if(method==='DELETE'){runs.delete(url.split('/').at(-1)!);return new Response(null,{status:204});}
    else value=runs.get(url.split('/')[4])??{};
    return new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
  }) as unknown as typeof fetch;
  const history=new DetectionHistory(fetcher);histories.push(history);
  return {history,requests,offline:(value:boolean)=>{offline=value;}};
}
const capture=(captureId=crypto.randomUUID(),revision=1,count=1):AttentionCapture=>({captureId,revision,id:'A',displayName:'A',labels:['Gục người'],firstAt:1000,lastAt:2000,count});

describe('nonblocking history outbox',()=>{
  it('shows a newly started run even when an older initial history read is still pending',async()=>{
    vi.useFakeTimers();let release!:(value:Response)=>void;
    const history=new DetectionHistory(async path=>String(path).endsWith('/days')?new Promise<Response>(yes=>{release=yes;}):new Response(JSON.stringify({runs:[]})));histories.push(history);
    const reading=history.load();expect(history.getSnapshot().loading).toBe(true);
    const id=history.begin('webcam','USB');
    expect(history.getSnapshot()).toMatchObject({activeId:id,selectedId:id,loading:false});
    release(new Response(JSON.stringify({days:[]})));await reading;
    // The stale read must not replace the live selection.
    expect(history.getSnapshot().detail?.id).toBe(id);
  });
  it('creates one block for repeated begin/resume, coalesces portraits and ignores stale revisions',async()=>{
    const {history,requests}=setup(),run=history.begin('pi','Pi'),entry=capture();
    expect(history.begin('pi','Pi')).toBe(run);
    history.enqueue(run,{...entry,photo:'latest-one'});
    history.enqueue(run,{...entry,revision:2,photo:'latest-two'});
    history.enqueue(run,{...entry,revision:3,count:2});
    await history.flush();
    expect(requests.filter(r=>r.method==='POST')).toHaveLength(1);
    const saved=requests.find(r=>r.method==='PUT')!.body.captures;
    expect(saved).toHaveLength(1);expect(saved[0]).toMatchObject({photo:'latest-two',count:2,revision:3});
    history.enqueue(run,entry);await history.flush();expect(requests.filter(r=>r.method==='PUT')).toHaveLength(1);
    expect(history.getSnapshot().detail!.captures[0].count).toBe(2);
  });
  it('waits for already-scheduled photo work before closing and keeps old work out of the next block',async()=>{
    const {history,requests}=setup(),old=history.begin('pi','Pi'),release=history.hold(old);
    history.end();const next=history.begin('pi','Pi');
    await history.flush();expect(requests.filter(r=>r.method==='PATCH')).toHaveLength(0);
    history.enqueue(old,capture());release();await history.flush();
    expect(requests.find(r=>r.method==='PUT')!.path).toContain(old);
    expect(requests.find(r=>r.method==='PATCH')!.path).toContain(old);
    expect(history.getSnapshot().activeId).toBe(next);expect(history.getSnapshot().detail!.peopleCount).toBe(0);
  });
  it('keeps snapshots during an outage and retries without duplicated blocks or counts',async()=>{
    const {history,requests,offline}=setup();offline(true);
    const run=history.begin('webcam','USB'),entry=capture();history.enqueue(run,entry);
    await history.flush();expect(history.getSnapshot().savingError).toContain('Chưa lưu được lịch sử');
    history.enqueue(run,{...entry,revision:2,count:2});offline(false);await history.flush();
    expect(history.getSnapshot().savingError).toBeUndefined();
    expect(requests.filter(r=>r.method==='POST')).toHaveLength(1);
    expect(requests.find(r=>r.method==='PUT')!.body.captures[0].count).toBe(2);
  });
  it('keeps more than 40 archived people while splitting bounded uploads',async()=>{
    const {history,requests}=setup(),run=history.begin('pi','Pi');
    for(let i=0;i<45;i++)history.enqueue(run,{...capture(),id:String(i)});
    await history.flush();const batches=requests.filter(r=>r.method==='PUT');
    expect(batches.map(r=>r.body.captures.length)).toEqual([20,20,5]);
    expect(history.getSnapshot().detail!.peopleCount).toBe(45);
  });
  it('does not restore a deleted block when an earlier upload acknowledgment arrives late',async()=>{
    vi.useFakeTimers();let acknowledge!:(value:Response)=>void,started!:()=>void;
    const uploading=new Promise<void>(yes=>{started=yes;});const methods:string[]=[];
    const history=new DetectionHistory(async(path,options)=>{
      const method=options?.method??'GET';methods.push(method);
      if(method==='PUT'){started();return new Promise<Response>(yes=>{acknowledge=yes;});}
      if(method==='DELETE')return new Response(null,{status:204});
      const result=method==='POST'?{number:1}:String(path).endsWith('/days')?{days:[]}:{runs:[]};
      return new Response(JSON.stringify(result));
    });histories.push(history);
    const run=history.begin('webcam','USB');history.enqueue(run,capture());history.end();
    const saving=history.flush();await uploading;await history.removeRun(run);
    acknowledge(new Response('{}'));await saving;
    expect(history.getSnapshot().runs).toEqual([]);expect(history.getSnapshot().detail).toBeUndefined();
    expect(methods).not.toContain('PATCH');
  });
  it('uses Vietnam midnight for the date and keeps an existing block on its start date',async()=>{
    expect(vietnamDay(Date.parse('2026-11-15T16:59:59Z'))).toBe('2026-11-15');
    expect(vietnamDay(Date.parse('2026-11-15T17:00:00Z'))).toBe('2026-11-16');
  });
});
