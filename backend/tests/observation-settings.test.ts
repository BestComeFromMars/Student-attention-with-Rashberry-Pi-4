import {describe,it,expect} from 'vitest';
import {createServer} from 'node:http';
import {defaultObservationSettings,parseObservationSettings,observationSettingsSchema,activeFeaturesForSettings} from '../src/observation-settings.js';
import {AttentionEvaluator} from '../src/attention.js';
import {PostureBehavior} from '../src/posture-behavior.js';
import {HeadMotion} from '../src/head-motion.js';
import {FacialBehavior} from '../src/facial-behavior.js';
import {Sessions} from '../src/sessions.js';
import {createApp} from '../src/app.js';
import type {StudentTrack,InferenceEngine} from '../src/types.js';

function person(at:number):StudentTrack{return {id:'A',displayName:'A',color:'',status:'visible',lastSeen:at,personId:7,
  box:{x:.1,y:.1,width:.3,height:.5},boxKind:'face',faceVisibility:'visible',
  observation:{valid:true,eyeAspectRatio:.3,yawOffset:0,yawDeg:0,pitchDeg:30,observedAt:at,phoneHeld:false,laptopInteraction:false,objectsAt:at}};}
const signal=(track:StudentTrack,type:string)=>track.signals!.find(item=>item.type===type)!;
describe('bounded observation settings',()=>{
  it('round-trips defaults and never shares mutable configuration between sessions',()=>{
    const first=defaultObservationSettings(),second=defaultObservationSettings();first.enabled.phone=true;first.objectsEnabled=true;
    expect(second.enabled.phone).toBe(false);expect(second.objectsEnabled).toBe(false);expect(parseObservationSettings(second)).toEqual(second);
    expect(observationSettingsSchema().behaviors).toHaveLength(11);
  });
  it.each([NaN,Infinity,-1,0,30001,100.5,'500',null])('rejects invalid durations: %s',value=>{
    const settings=defaultObservationSettings();Object.assign(settings.thresholds,{phoneMs:value});
    expect(()=>parseObservationSettings(settings)).toThrow();
  });
  it('rejects missing, unknown and wrongly typed switches and thresholds',()=>{
    for(const change of [(s:any)=>{delete s.enabled.phone;},(s:any)=>{s.enabled.phone='yes';},(s:any)=>{s.thresholds.extra=1;},(s:any)=>{delete s.thresholds.slumpMs;},(s:any)=>{s.thresholds.deskRestConfidencePercent=24;}]){
      const settings:any=defaultObservationSettings();change(settings);expect(()=>parseObservationSettings(settings)).toThrow();
    }
  });
});
describe('settings change actual confirmation rules',()=>{
  it.each([
    ['eyes_closed','eyesClosedMs',(p:StudentTrack)=>Object.assign(p.observation!,{eyeAspectRatio:.08,eyeBlinkLeft:.95,eyeBlinkRight:.95})],
    ['phone','phoneMs',(p:StudentTrack)=>{p.observation!.phoneHeld=true;}],
    ['head_down','headDownMs',()=>{}],
    ['yawn','yawnMs',(p:StudentTrack)=>{p.observation!.mouthOpenRatio=.8;}],
    ['laptop','laptopMs',(p:StudentTrack)=>{p.observation!.laptopInteraction=true;}],
    ['upper_body_slumped','slumpMs',(p:StudentTrack)=>{p.faceVisibility='unavailable';p.observation!.valid=false;
      p.observation!.deskRest={active:true,confidence:.4,personConfidence:.2,observedAt:p.lastSeen};}],
  ] as const)('applies custom duration and disable switch to %s',(kind,key,change)=>{
    const settings=defaultObservationSettings();settings.thresholds[key]=2000;settings.enabled[kind]=true;settings.objectsEnabled=true;
    const defaults=defaultObservationSettings();defaults.enabled[kind]=true;defaults.objectsEnabled=true;
    const configured=new AttentionEvaluator(settings),normal=new AttentionEvaluator(defaults);
    let result:StudentTrack;
    for(const at of [1000,1900,2600,3100]){
      const p=person(at);change(p);result=configured.evaluate([p],at)[0];
      const ordinary=normal.evaluate([p],at)[0];
      if(at===2600){expect(signal(result,kind).state).toBe('pending');expect(signal(ordinary,kind).state).toBe('confirmed');}
    }
    expect(signal(result!,kind).state).toBe('confirmed');
    settings.enabled[kind]=false;const off=new AttentionEvaluator(settings);
    for(const at of [4000,5000,6000,7000]){const p=person(at);change(p);result=off.evaluate([p],at)[0];}
    expect(result!.alerts!.some(a=>a.type===kind)).toBe(false);expect(signal(result!,kind).state).toBe('unavailable');
  });
  it('applies head angle, sustained turn, smile score and smile duration',()=>{
    const thresholds=defaultObservationSettings().thresholds;
    Object.assign(thresholds,{headTurnAngleDeg:40,headTurnedMs:500,smilePercent:80,turnedSmilingMs:200});
    const engine=new PostureBehavior(1000,0,thresholds);
    const run=(at:number,yaw:number,smile=.7)=>engine.update({heading:{value:yaw,source:'face',at},smile:{left:smile,right:smile,at}},at).signals;
    expect(run(1000,30)[0].state).toBe('clear');run(1500,45);
    expect(run(2000,45)[0].state).toBe('confirmed');expect(run(2500,45)[2].state).toBe('clear');
    run(2700,45,.9);expect(run(2900,45,.9)[2].state).toBe('confirmed');
  });
  it('requires the configured turn count within the configured window',()=>{
    const thresholds=defaultObservationSettings().thresholds;thresholds.headTurnChanges=4;thresholds.headTurnWindowMs=2000;
    const head=new HeadMotion(thresholds);
    const move=(yaw:number,at:number)=>{head.update(yaw,at,at,'face');return head.update(yaw,at+150,at+150,'face');};
    move(0,1000);move(-.4,1400);move(0,1800);expect(move(.4,2200).state).toBe('pending');
    expect(move(0,2600).state).toBe('confirmed');expect(head.update(0,4200,4200,'face').state).toBe('pending');
  });
  it('applies the torso geometry and slump tilt thresholds to the same pose',()=>{
    const keypoints=Array.from({length:17},()=>({x:.5,y:.8,confidence:.9}));
    keypoints[0]={x:.5,y:.2,confidence:.9};keypoints[5]={x:.34,y:.4,confidence:.9};keypoints[6]={x:.66,y:.4,confidence:.9};
    const thresholds=defaultObservationSettings().thresholds;thresholds.torsoNarrowPercent=90;thresholds.torsoTurnedMs=500;
    const configured=new PostureBehavior(1000,0,thresholds),ordinary=new PostureBehavior(1000);
    const sample=(at:number)=>({heading:{value:35,source:'face',at},smile:null,
      pose:{keypoints,box:{x:.1,y:.1,width:.8,height:.8},aspectRatio:1,confidence:.9,observedAt:at,source:'YOLO11n-pose' as const}});
    configured.update(sample(1000),1000);ordinary.update(sample(1000),1000);
    expect(configured.update(sample(1500),1500).signals[1].state).toBe('confirmed');
    expect(ordinary.update(sample(1500),1500).signals[1].state).toBe('clear');
    keypoints[5].x=.35;keypoints[6].x=.65;keypoints[0].y=.42;
    keypoints[11]={x:.75,y:.7,confidence:.9};keypoints[12]={x:.85,y:.7,confidence:.9};
    const strict=new PostureBehavior(2000,0,{...thresholds,slumpTiltDeg:60,slumpMs:500});
    const sensitive=new PostureBehavior(2000,0,{...thresholds,slumpTiltDeg:30,slumpMs:500});
    strict.update(sample(2000),2000);sensitive.update(sample(2000),2000);
    expect(strict.update(sample(2500),2500).signals[3].state).toBe('clear');
    expect(sensitive.update(sample(2500),2500).signals[3].state).toBe('confirmed');
  });
  it('applies the custom speech duration and cycles without weakening the anti-smile guard',()=>{
    const thresholds=defaultObservationSettings().thresholds;thresholds.talkingCycles=2;thresholds.talkingMs=300;
    const face=new FacialBehavior(thresholds);let result:ReturnType<FacialBehavior['update']>;
    for(const [at,mouth] of [[1000,.05],[1100,.15],[1200,.05],[1400,.15],[1500,.05]]){
      result=face.update({...person(at).observation!,mouthOpenRatio:mouth},at,true);
    }
    expect(result!.talking.state).toBe('confirmed');
    expect(face.update({...person(1600).observation!,mouthOpenRatio:.15,mouthSmileLeft:.7,mouthSmileRight:.7},1600,true).talking.state).toBe('clear');
  });
  it('applies the auxiliary desk-rest confidence before the dwell',()=>{
    const thresholds=defaultObservationSettings().thresholds;thresholds.deskRestConfidencePercent=60;thresholds.slumpMs=500;
    const engine=new PostureBehavior(1000,0,thresholds);
    const run=(at:number,confidence:number)=>engine.update({heading:null,smile:null,deskRest:{active:true,confidence,personConfidence:.2,observedAt:at}},at).signals[3];
    run(1000,.4);expect(run(2000,.4).state).toBe('unavailable');
    run(2500,.7);expect(run(3000,.7).state).toBe('confirmed');
  });
});
describe('per-session configuration and HTTP',()=>{
  it('clears old alerts on apply, preserves IDs, isolates sessions and retains settings after a source switch',async()=>{
    let now=1000;const sessions=new Sessions(()=>now),a=sessions.create(),b=sessions.create();
    const engine:InferenceEngine={ready:true,close:async()=>{},detect:async()=>[person(now)]};
    await sessions.detect(a,Buffer.from('x'),engine);now=2000;
    expect((await sessions.detect(a,Buffer.from('x'),engine))[0].alerts!.length).toBeGreaterThan(0);
    const settings=defaultObservationSettings();settings.thresholds.headDownPitchDeg=50;sessions.configure(a,settings);
    expect((await sessions.detect(a,Buffer.from('x'),engine))[0]).toMatchObject({id:'A',attention:'uncertain',alerts:[]});
    expect(sessions.settings(b).thresholds.headDownPitchDeg).toBe(18);
    now=3000;await sessions.detect(a,Buffer.from('x'),engine,'pi');now=4000;
    expect((await sessions.detect(a,Buffer.from('x'),engine,'pi'))[0].alerts).toEqual([]);
    const returned=sessions.settings(a);returned.enabled.phone=true;expect(sessions.settings(a).enabled.phone).toBe(false);
  });
  it('does not change configuration in the middle of an in-flight detection',async()=>{
    const sessions=new Sessions(()=>1000),id=sessions.create();let finish!:()=>void;
    const engine:InferenceEngine={ready:true,close:async()=>{},detect:()=>new Promise(resolve=>{finish=()=>resolve([]);})};
    const pending=sessions.detect(id,Buffer.from('x'),engine);
    expect(()=>sessions.configure(id,defaultObservationSettings())).toThrow(/khung hình/);finish();await pending;
    expect(()=>sessions.configure(id,defaultObservationSettings())).not.toThrow();
  });
  it('serves the schema, validates updates and accepts settings when creating a session',async()=>{
    const engine:InferenceEngine={ready:true,close:async()=>{},detect:async()=>[]};
    const server=createServer(createApp({engine}));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
    try{
      expect((await (await fetch(origin+'/api/observation-settings')).json()).behaviors).toHaveLength(11);
      const settings=defaultObservationSettings();settings.thresholds.slumpMs=500;
      const created=await fetch(origin+'/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings})});
      expect(created.status).toBe(201);const {sessionId}=await created.json();
      const endpoint=origin+'/api/sessions/'+sessionId+'/settings';
      expect((await (await fetch(endpoint)).json()).settings.thresholds.slumpMs).toBe(500);
      expect((await fetch(endpoint,{method:'PUT',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(400);
      expect((await (await fetch(endpoint)).json()).settings.thresholds.slumpMs).toBe(500);
      settings.enabled.upper_body_slumped=false;
      expect((await fetch(endpoint,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)})).status).toBe(200);
      expect((await (await fetch(endpoint)).json()).settings.enabled.upper_body_slumped).toBe(false);
    }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it('gates objects and forwards active AI feature flags to the engine',async()=>{
    const defaults=defaultObservationSettings();
    expect(activeFeaturesForSettings(defaults)).toEqual({
      objects:false,hands:false,faceMesh:true,profileMesh:true,pose:true,deskRest:true,faceHeading:true,
    });
    const configured:unknown[]=[];
    const sessions=new Sessions(()=>1000),id=sessions.create(defaults);
    const engine:InferenceEngine={ready:true,close:async()=>{},configure:(sessionId,features)=>configured.push({sessionId,features}),detect:async()=>[]};
    await sessions.detect(id,Buffer.from('x'),engine);
    expect(configured).toHaveLength(1);
    const next=defaultObservationSettings();next.objectsEnabled=true;next.enabled.phone=true;next.enabled.upper_body_slumped=false;
    sessions.configure(id,next,engine);
    expect(configured).toHaveLength(2);
    expect((configured[1] as {features:Record<string,boolean>}).features).toMatchObject({objects:true,hands:true,deskRest:false});
  });
});
