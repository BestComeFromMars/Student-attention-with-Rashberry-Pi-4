import {describe,it,expect} from 'vitest';
import {createServer} from 'node:http';
import sharp from 'sharp';
import {createApp} from '../src/app.js';
import {Sessions} from '../src/sessions.js';
import {PiSource} from '../src/pi-source.js';
import {defaultObservationSettings} from '../src/observation-settings.js';
import type {InferenceEngine} from '../src/types.js';

describe('Pi video protocol with the current observation API',()=>{
  it('streams new camera frames and serves health while AI is stalled, then returns all three independent box types',async()=>{
    let finish!:(value:Awaited<ReturnType<NonNullable<InferenceEngine['detectFrame']>>>)=>void;
    let entered!:()=>void;
    const waiting=new Promise<void>(resolve=>{entered=resolve;});
    const result=new Promise<Awaited<ReturnType<NonNullable<InferenceEngine['detectFrame']>>>>(resolve=>{finish=resolve;});
    const engine:InferenceEngine={ready:true,close:async()=>{},detect:async()=>[],detectFrame:async()=>{entered();return result;}};
    const pi=new PiSource(),sessions=new Sessions(),id=sessions.create({...defaultObservationSettings(),objectsEnabled:true});
    const server=createServer(createApp({engine,pi,sessions}));
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
    const abort=new AbortController();
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    let detection:Promise<Response>|undefined;
    try{
      const image=(color:string)=>sharp({create:{width:320,height:240,channels:3,background:color}}).jpeg().toBuffer();
      await pi.update(await image('#102030'));
      const stream=await fetch(origin+'/api/pi/stream',{signal:abort.signal});
      reader=stream.body!.getReader();await reader.read();
      let completed=false;
      detection=fetch(origin+`/api/sessions/${id}/detect/pi`,{method:'POST'}).then(response=>{completed=true;return response;});
      await waiting;
      for(const color of ['#405060','#708090','#a0b0c0']){
        const next=await image(color);await pi.update(next);
        const chunk=await reader.read();
        expect(Buffer.from(chunk.value!).includes(next)).toBe(true);
        expect(completed).toBe(false);
      }
      expect((await fetch(origin+'/api/health')).status).toBe(200);
      const now=Date.now(),personBox={x:.1,y:.1,width:.4,height:.8},faceBox={x:.2,y:.15,width:.15,height:.2};
      finish({frameAt:now,people:[{personId:1,geometryId:2,box:personBox,personBox,faceBox,boxKind:'person',faceVisibility:'visible',trackingState:'face'}],
        objects:[{id:'O1',kind:'book',box:{x:.5,y:.6,width:.2,height:.2},confidence:.9,trackedAt:now,observedAt:now,trackingState:'detected'}]});
      const data=await (await detection).json();
      expect(data.tracks[0].displayBoxes.person).toBeDefined();expect(data.tracks[0].displayBoxes.face).toBeDefined();
      expect(data.objects[0].displayBox).toBeDefined();expect(data.objects[0].ownerId).toBeUndefined();
      expect(data.processingMs).toBeGreaterThan(0);expect(data.frameAgeMs).toBeGreaterThanOrEqual(0);
    }finally{
      finish({people:[],objects:[]});await detection;abort.abort();await reader?.cancel().catch(()=>{});
      pi.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  },10000);
  it('routes Pi JPEG and webcam uploads through the same settings, evidence and display-box pipeline',async()=>{
    let now=Date.now(),calls=0;
    const engine:InferenceEngine={ready:true,close:async()=>{},detect:async()=>[],detectFrame:async(bytes)=>{
      expect(bytes[0]).toBe(255);expect(bytes[1]).toBe(216);calls++;
      return {frameAt:now,objects:[],people:[{personId:7,geometryId:9,boxKind:'person',trackingState:'face',
        box:{x:.2,y:.1,width:.3,height:.7},personBox:{x:.2,y:.1,width:.3,height:.7},faceBox:{x:.25,y:.15,width:.12,height:.16},faceVisibility:'visible',
        observation:{valid:true,facePixels:100,mouthValid:true,mouthSource:'face_landmarker',eyeAspectRatio:.3,yawOffset:0,yawDeg:0,pitchDeg:30,observedAt:now,
          mouthOpenRatio:.05,objectsAt:now,phoneHeld:false,laptopInteraction:false}}]};
    }};
    const pi=new PiSource(),sessions=new Sessions(()=>now),server=createServer(createApp({engine,pi,sessions,piToken:'test-only-token'}));
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
    const jpeg=await sharp({create:{width:1280,height:720,channels:3,background:'#8090a0'}}).jpeg().toBuffer();
    const post=async(path:string,body?:Buffer,headers:Record<string,string>={})=>fetch(origin+path,{method:'POST',headers,body:body as unknown as BodyInit});
    try{
      expect((await post('/api/pi/frame',jpeg,{'Content-Type':'image/jpeg'})).status).toBe(401);
      expect((await post('/api/pi/frame',jpeg,{'Content-Type':'image/jpeg','X-Pi-Token':'test-only-token'})).status).toBe(202);
      expect(pi.status()).toMatchObject({online:true,width:1280,height:720});
      const settings=defaultObservationSettings();settings.thresholds.headDownMs=200;
      const piId=sessions.create(settings),usbId=sessions.create(settings);
      await post(`/api/sessions/${piId}/detect/pi`);await post(`/api/sessions/${usbId}/detect`,jpeg,{'Content-Type':'image/jpeg'});
      now+=300;
      const fromPi=await (await post(`/api/sessions/${piId}/detect/pi`)).json();
      const fromUsb=await (await post(`/api/sessions/${usbId}/detect`,jpeg,{'Content-Type':'image/jpeg'})).json();
      for(const result of [fromPi,fromUsb]){
        expect(result.tracks[0]).toMatchObject({id:'A',personId:7,faceVisibility:'visible',attention:'needs_attention'});
        expect(result.tracks[0].displayBoxes.person).toBeDefined();expect(result.tracks[0].displayBoxes.face).toBeDefined();
        expect(result.tracks[0].signals.find((s:{type:string})=>s.type==='talking').state).toBe('clear');
        expect(result.tracks[0].alerts.some((a:{type:string})=>a.type==='head_down')).toBe(true);
      }
      settings.enabled.head_down=false;
      const applied=await fetch(origin+`/api/sessions/${piId}/settings`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)});
      expect(applied.status).toBe(200);now+=300;
      const after=await (await post(`/api/sessions/${piId}/detect/pi`)).json();
      expect(after.tracks[0].id).toBe('A');expect(after.tracks[0].alerts).toEqual([]);
      expect(sessions.settings(usbId).enabled.head_down).toBe(true);
      pi.close();expect((await post(`/api/sessions/${piId}/detect/pi`)).status).toBe(503);
      expect(calls).toBe(5);
    }finally{pi.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});
