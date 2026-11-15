import {describe,it,expect,beforeEach,afterEach} from 'vitest';
import {mkdir,mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import sharp from 'sharp';
import {HistoryStore,historyDay} from '../src/history-store.js';
import {createApp} from '../src/app.js';

let folder:string,store:HistoryStore;
const start=Date.parse('2026-11-15T16:59:50Z');
const person=(captureId=randomUUID(),revision=1,count=1)=>({captureId,trackId:'A',displayName:'Học sinh A',
  labels:['Quay lệch hướng lâu'],firstAt:start,lastAt:start+1000,revision,count});
const photo=async(color:string)=>'data:image/jpeg;base64,'+(await sharp({create:{width:160,height:160,channels:3,background:color}}).jpeg().toBuffer()).toString('base64');
beforeEach(async()=>{const parent=resolve('../.qa/history/tests');await mkdir(parent,{recursive:true});folder=await mkdtemp(join(parent,'store-'));store=new HistoryStore(folder);});
afterEach(async()=>{await store.close();await rm(folder,{recursive:true,force:true});});

describe('daily JSON history with bounded portraits',()=>{
  it('numbers concurrent starts once, resets on Vietnam midnight, and preserves the start day across midnight',async()=>{
    const id=randomUUID();
    const result=await Promise.all(Array.from({length:5},()=>store.create({id,startedAt:start,source:'pi',cameraLabel:'Pi'})));
    expect(new Set(result.map(r=>r.number))).toEqual(new Set([1]));
    expect(historyDay(start)).toBe('2026-11-15');
    expect((await store.create({id:randomUUID(),startedAt:start+20000,source:'webcam'})).number).toBe(1);
    await store.update(id,{captures:[{...person(),lastAt:start+30000}]});await store.end(id,{endedAt:start+60000});
    expect((await store.get(id)).date).toBe('2026-11-15');
    expect(await store.listDays()).toEqual(['2026-11-16','2026-11-15']);
  });
  it('overwrites exactly one JPEG per person, ignores stale revisions and reloads counts after restart',async()=>{
    const id=randomUUID(),capture=person(),red=await photo('#ff0000'),blue=await photo('#0000ff');
    await store.create({id,startedAt:start,source:'pi'});
    await store.update(id,{captures:[{...capture,photo:red,photoAt:start}]});
    await store.update(id,{captures:[{...capture,revision:3,count:2,photo:blue,photoAt:start+2000}]});
    await store.update(id,{captures:[{...capture,revision:2,count:1,photo:red}]});
    const path=join(folder,'2026-11-15',id);
    expect(await readdir(path)).toEqual([capture.captureId+'.jpg']);
    const pixel=await sharp(await store.photo(id,capture.captureId)).raw().toBuffer();expect(pixel[2]).toBeGreaterThan(240);expect(pixel[0]).toBeLessThan(10);
    const json=await readFile(join(folder,'2026-11-15/history.json'),'utf8');expect(json).not.toContain('base64');
    const restarted=new HistoryStore(folder);
    const result=await restarted.get(id);expect(result.captures[0]).toMatchObject({count:2,revision:3,photoRevision:3});
    expect(result.captures[0].photoUrl).toContain('?v=3');
    expect((await restarted.create({id:randomUUID(),startedAt:start,source:'webcam'})).number).toBe(2);
    await restarted.close();
  });
  it('retains more than 40 archived people and saves metadata without a face',async()=>{
    const id=randomUUID();await store.create({id,startedAt:start,source:'webcam'});
    const values=Array.from({length:45},()=>person());
    await store.update(id,{captures:values.slice(0,30)});await store.update(id,{captures:values.slice(30)});
    expect((await store.get(id)).peopleCount).toBe(45);
    expect((await store.get(id)).eventCount).toBe(45);
    await expect(store.photo(id,values[0].captureId)).rejects.toMatchObject({status:404});
  });
  it('marks a retained photo as preceding a new warning without writing another JPEG',async()=>{
    const id=randomUUID(),capture=person();await store.create({id,startedAt:start,source:'pi'});
    await store.update(id,{captures:[{...capture,photo:await photo('#008800'),photoAt:start,photoBeforeAlert:false}]});
    const original=await store.photo(id,capture.captureId);
    await store.update(id,{captures:[{...capture,count:2,revision:2,lastAt:start+3000,photoBeforeAlert:true}]});
    const restarted=new HistoryStore(folder);
    expect((await restarted.get(id)).captures[0]).toMatchObject({count:2,photoRevision:1,photoAt:start,photoBeforeAlert:true});
    expect(await restarted.photo(id,capture.captureId)).toEqual(original);await restarted.close();
  });
  it('deletes photos and blocks late updates/recreation without reusing daily numbers',async()=>{
    const id=randomUUID(),capture=person();await store.create({id,startedAt:start,source:'pi'});
    await store.update(id,{captures:[{...capture,photo:await photo('#008800')}]});
    await store.removeRun(id);
    await expect(readdir(join(folder,'2026-11-15',id))).rejects.toMatchObject({code:'ENOENT'});
    await expect(store.update(id,{captures:[{...capture,revision:2}]})).rejects.toMatchObject({status:410});
    await expect(store.create({id,startedAt:start,source:'pi'})).rejects.toMatchObject({status:410});
    const next=await store.create({id:randomUUID(),startedAt:start,source:'pi'});expect(next.number).toBe(2);
    await store.removeDay('2026-11-15');expect(await store.listDays()).toEqual([]);
    const restarted=new HistoryStore(folder);
    expect((await restarted.create({id:randomUUID(),startedAt:start,source:'pi'})).number).toBe(3);
    await expect(restarted.create({id:next.id,startedAt:start,source:'pi'})).rejects.toMatchObject({status:410});await restarted.close();
  });
  it('rejects invalid paths, photos and decreasing counts without changing committed data',async()=>{
    await expect(store.listRuns('../../outside')).rejects.toMatchObject({status:400});
    await expect(store.listRuns('2026-99-99')).rejects.toMatchObject({status:400});
    await expect(store.create({id:'../../outside',source:'pi'})).rejects.toMatchObject({status:400});
    const id=randomUUID(),capture=person();await store.create({id,startedAt:start,source:'pi'});await store.update(id,{captures:[capture]});
    await expect(store.update(id,{captures:[{...capture,revision:2,photo:'data:image/jpeg;base64,bm90YWpwZWc='}]})).rejects.toMatchObject({status:400});
    await expect(store.update(id,{captures:[{...capture,revision:2,count:0}]})).rejects.toMatchObject({status:400});
    expect((await store.get(id)).captures[0].revision).toBe(1);
  });
  it('can retry initialization after a temporary filesystem failure',async()=>{
    const path=join(folder,'unavailable');await writeFile(path,'occupied');const recovering=new HistoryStore(path);
    await expect(recovering.listDays()).rejects.toBeDefined();await rm(path);expect(await recovering.listDays()).toEqual([]);await recovering.close();
  });
  it('exposes history while models load and serves only validated image routes',async()=>{
    const server=createServer(createApp({history:store,engine:{ready:false,detect:async()=>[],close:async()=>{}}}));
    await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    try{
      expect((await fetch(origin+'/api/history/days')).status).toBe(200);
      const id=randomUUID();const response=await fetch(origin+'/api/history/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,startedAt:start,source:'pi'})});
      expect(response.status).toBe(201);expect((await response.json()).number).toBe(1);
      expect((await fetch(origin+'/api/history/days',{headers:{Origin:'https://example.com'}})).status).toBe(403);
      expect((await fetch(origin+'/api/history/runs/not-an-id')).status).toBe(400);
    }finally{server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}
  });
});
