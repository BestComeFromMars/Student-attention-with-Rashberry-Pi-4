import {describe,it,expect,vi} from 'vitest';
import {createServer} from 'node:http';
import {createApp} from '../src/app.js';
import {InferenceRuntime} from '../src/inference-runtime.js';
import {defaultObservationSettings} from '../src/observation-settings.js';
import type {InferenceEngine} from '../src/types.js';

describe('production inference runtime camera bridge',()=>{
  it('routes camera pixels, detection seeds and release through the startup wrapper over HTTP',async()=>{
    const box={x:.1,y:.1,width:.4,height:.8},face={x:.2,y:.15,width:.12,height:.16};
    const seeds=vi.fn(),release=vi.fn(),close=vi.fn(async()=>{});
    const track=vi.fn(async(_jpeg:Buffer,context:{sessionId:string;frameId:number;capturedAt?:number})=>
      ({frameId:context.frameId,boxes:[{key:'person:A',box}],processingMs:2}));
    const detect=vi.fn(async(_jpeg:Buffer,context?:{sessionId:string;frameId?:number})=>{
      const now=Date.now();
      return {frameAt:now,people:[{personId:7,geometryId:9,box,personBox:box,faceBox:face,
        boxKind:'person' as const,trackingState:'face' as const,faceVisibility:'visible' as const,
        geometryFrameIds:{person:context!.frameId!,face:context!.frameId!}}],
        objects:[{id:'O1',kind:'book' as const,box:face,confidence:.9,observedAt:now,trackedAt:now,trackingState:'detected' as const}]};
    });
    const native:InferenceEngine={ready:true,detect:async()=>[],detectFrame:detect,trackFrame:track,
      seedGeometry:seeds,release,close};
    const runtime=new InferenceRuntime(async()=>native);
    await runtime.start();
    const server=createServer(createApp({engine:runtime}));
    await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));
    const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const jpeg=new Uint8Array([255,216,255,217]);
    try{
      const created=await fetch(origin+'/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({settings:{...defaultObservationSettings(),objectsEnabled:true}})});
      const {sessionId}=await created.json();
      const tracked=await fetch(origin+`/api/sessions/${sessionId}/track`,{method:'POST',body:jpeg,
        headers:{'Content-Type':'image/jpeg','X-Frame-Id':'11','X-Frame-Captured-At':'1234.5'}});
      expect(tracked.status).toBe(200);
      expect(await tracked.json()).toMatchObject({frameId:11,boxes:[{key:'person:A',box}]});
      expect(track).toHaveBeenCalledWith(Buffer.from(jpeg),{sessionId,frameId:11,capturedAt:1234.5});
      const detected=await fetch(origin+`/api/sessions/${sessionId}/detect`,{method:'POST',body:jpeg,
        headers:{'Content-Type':'image/jpeg','X-Frame-Id':'11'}});
      expect(detected.status).toBe(200);
      expect((await detected.json()).tracks[0].id).toBe('A');
      expect(detect).toHaveBeenCalledWith(Buffer.from(jpeg),{sessionId,frameId:11});
      expect(seeds).toHaveBeenCalledWith(sessionId,[
        {key:'person:A',box,frameId:11,owner:7},{key:'face:A',box:face,frameId:11,owner:7},
        {key:'object:O1',box:face,frameId:11},
      ]);
      expect((await fetch(origin+`/api/sessions/${sessionId}`,{method:'DELETE'})).status).toBe(204);
      expect(release).toHaveBeenCalledWith(sessionId);
    }finally{
      server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));
      await runtime.close();
    }
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects geometry while loading or closed and never sends seeds after shutdown',async()=>{
    let finish!:(engine:InferenceEngine)=>void;
    const track=vi.fn(async()=>({frameId:1,boxes:[],processingMs:0})),seed=vi.fn(),close=vi.fn(async()=>{});
    const runtime=new InferenceRuntime(()=>new Promise<InferenceEngine>(yes=>{finish=yes;}));
    const start=runtime.start();
    const context={sessionId:'camera',frameId:1,capturedAt:0};
    await expect(runtime.trackFrame(Buffer.alloc(4),context)).rejects.toMatchObject({status:503});
    runtime.seedGeometry('camera',[]);expect(seed).not.toHaveBeenCalled();
    finish({ready:true,detect:async()=>[],trackFrame:track,seedGeometry:seed,close});await start;
    await expect(runtime.trackFrame(Buffer.alloc(4),context)).resolves.toMatchObject({frameId:1});
    runtime.seedGeometry('camera',[]);expect(seed).toHaveBeenCalledTimes(1);
    await runtime.close();
    await expect(runtime.trackFrame(Buffer.alloc(4),context)).rejects.toMatchObject({status:503});
    runtime.seedGeometry('camera',[]);expect(seed).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('reports unsupported legacy engines and preserves underlying geometry errors',async()=>{
    const legacy=new InferenceRuntime(async()=>({ready:true,detect:async()=>[],close:async()=>{}}));
    await legacy.start();
    await expect(legacy.trackFrame(Buffer.alloc(4),{sessionId:'legacy',frameId:1})).rejects.toMatchObject({status:503});
    await legacy.close();
    const failure=Object.assign(new Error('invalid frame'),{status:422});
    const runtime=new InferenceRuntime(async()=>({ready:true,detect:async()=>[],close:async()=>{},
      trackFrame:async()=>{throw failure;}}));
    await runtime.start();
    await expect(runtime.trackFrame(Buffer.alloc(4),{sessionId:'camera',frameId:1})).rejects.toBe(failure);
    await runtime.close();
  });
});
