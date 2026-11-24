import {describe,it,expect,vi} from 'vitest';
import {PostureBehavior} from '../src/posture-behavior.js';
import {AttentionEvaluator} from '../src/attention.js';
import {Sessions} from '../src/sessions.js';
import type {BodyPose,StudentTrack,InferenceEngine} from '../src/types.js';

function pose(at:number,kind:'normal'|'turn'|'slump'|'read'='normal',hips=true):BodyPose{
  const keypoints=Array.from({length:17},()=>({x:.5,y:.8,confidence:.9}));
  keypoints[0]={x:.5,y:kind==='slump'?.67:kind==='read'?.4:.2,confidence:.9};
  keypoints[5]={x:kind==='turn'?.4:.3,y:kind==='slump'?hips?.65:.57:.4,confidence:.9};
  keypoints[6]={x:kind==='turn'?.6:.7,y:keypoints[5].y,confidence:.9};
  keypoints[7]={x:.3,y:.65,confidence:.9};keypoints[8]={x:.7,y:.65,confidence:.9};
  keypoints[11]={x:.4,y:.8,confidence:hips?.9:0};keypoints[12]={x:.6,y:.8,confidence:hips?.9:0};
  return {box:{x:.15,y:.1,width:.7,height:.85},aspectRatio:1,keypoints,confidence:.9,observedAt:at,source:'YOLO11n-pose'};
}
function input(at:number,yaw=0,kind:'normal'|'turn'|'slump'|'read'='normal',hips=true){
  return {heading:{value:yaw,source:'face_pose',at},pose:pose(at,kind,hips),pitch:0,
    smile:{left:0,right:0,at}};
}
function calibrated(hips=true,yaw=0){
  const engine=new PostureBehavior(1000);
  for(let at=1000;at<=13000;at+=500)engine.update(input(at,yaw,'normal',hips),at);
  return engine;
}
const find=(result:ReturnType<PostureBehavior['update']>,kind:string)=>result.signals.find(s=>s.type===kind)!;

describe('immediate camera reference and sustained observations',()=>{
  it('can establish stable elbows at the actual sparse AI cadence without using duplicate samples',()=>{
    const engine=new PostureBehavior(1000);
    for(const at of [1000,1800])expect(find(engine.update(input(at,0,'normal',false),at),'upper_body_slumped').state).toBe('unavailable');
    expect(find(engine.update(input(2600,0,'normal',false),2600),'upper_body_slumped').state).toBe('clear');
    const repeated=new PostureBehavior(1000);
    for(const now of [1000,1800,2600])expect(find(repeated.update(input(1000,0,'normal',false),now),'upper_body_slumped').state).toBe('unavailable');
  });
  it('continues a previously verified folded person with fresh specialist detections when the general-person detector misses',()=>{
    const engine=new PostureBehavior(1000);let result:ReturnType<PostureBehavior['update']>;
    const sample=(at:number)=>({heading:null,smile:null,deskRest:{active:true,confidence:.45,personConfidence:.04,
      candidateConfidence:.04,temporalPerson:true,personObservedAt:1000,personConfirmedAt:1000,trackedBodyAt:at,observedAt:at,imageAt:at}});
    for(let at=3000;at<=6500;at+=500)result=engine.update(sample(at),at+600);
    expect(find(result!,'upper_body_slumped').state).toBe('confirmed');
    const stale=sample(6500);stale.deskRest.observedAt=9000;stale.deskRest.imageAt=9000;
    expect(find(engine.update(stale,9600),'upper_body_slumped').state).toBe('unavailable','a new reply cannot renew a cached specialist detection');
    expect(find(engine.update(sample(6500),9600),'upper_body_slumped').state).toBe('unavailable');
  });
  it('recognizes a face-hidden folded person from temporally corroborated weak person detections without changing the raw scores',()=>{
    const engine=new PostureBehavior(1000);let result:ReturnType<PostureBehavior['update']>;
    for(const at of [1000,1500,2000,2500]){
      const rest={active:true,confidence:.45,personConfidence:.04,candidateConfidence:.04,temporalPerson:true,personObservedAt:at-500,observedAt:at};
      result=engine.update({heading:null,smile:null,deskRest:rest},at);
      expect(rest.personConfidence).toBe(.04);
    }
    expect(find(result!,'upper_body_slumped')).toMatchObject({state:'confirmed',durationMs:1500,observedAt:2500});
  });
  it('rejects weak person scores without temporal proof and rejects stale or missing independent measurements',()=>{
    for(const overrides of [{temporalPerson:false},{candidateConfidence:undefined},{candidateConfidence:.02},{personConfidence:.02},
      {personObservedAt:undefined},{personObservedAt:0},{personObservedAt:10000}]){
      const engine=new PostureBehavior(1000);
      for(const at of [1000,1500,2000,2500]){
        const rest={active:true,confidence:.6,personConfidence:.04,candidateConfidence:.04,temporalPerson:true,personObservedAt:at,observedAt:at,...overrides};
        expect(find(engine.update({heading:null,smile:null,deskRest:rest},at),'upper_body_slumped').state).not.toBe('confirmed');
      }
    }
  });
  it('does not count cached temporal posture evidence twice or override an upright body',()=>{
    const engine=new PostureBehavior(1000);
    const rest={active:true,confidence:.6,personConfidence:.04,candidateConfidence:.04,temporalPerson:true,personObservedAt:1000,observedAt:1000};
    engine.update({heading:null,smile:null,deskRest:rest},1000);
    expect(find(engine.update({heading:null,smile:null,deskRest:rest},2700),'upper_body_slumped').state).toBe('pending');
    expect(find(engine.update({heading:null,smile:null,deskRest:rest},3100),'upper_body_slumped').state).toBe('unavailable');
    const upright=new PostureBehavior(1000);
    for(const at of [1000,1500,2000,2500])expect(find(upright.update({...input(at),deskRest:{...rest,observedAt:at,personObservedAt:at}},at),'upper_body_slumped').state).toBe('clear');
  });
  it('measures person evidence age at the analyzed image time while rejecting stale or future image stamps',()=>{
    const engine=new PostureBehavior(1000);let result:ReturnType<PostureBehavior['update']>;
    for(const at of [1000,1500,2000,2500])result=engine.update({heading:null,smile:null,
      deskRest:{active:true,confidence:.45,personConfidence:.04,candidateConfidence:.04,temporalPerson:true,
        personObservedAt:at-1500,observedAt:at,imageAt:at}},at+700);
    expect(find(result!,'upper_body_slumped').state).toBe('confirmed');
    const sample=(imageAt:number,personAt=imageAt-1500)=>({heading:null,smile:null,
      deskRest:{active:true,confidence:.45,personConfidence:.04,candidateConfidence:.04,temporalPerson:true,
        personObservedAt:personAt,observedAt:imageAt,imageAt}});
    expect(find(engine.update(sample(2500,0),3200),'upper_body_slumped').state).toBe('unavailable');
    expect(find(engine.update(sample(4000),3200),'upper_body_slumped').state).toBe('unavailable');
    expect(find(engine.update(sample(1000),3200),'upper_body_slumped').state).toBe('unavailable');
  });
  it('confirms corroborated desk-rest evidence without any face or pose after the ordinary dwell',()=>{
    const engine=new PostureBehavior(1000);let result:ReturnType<PostureBehavior['update']>;
    for(const at of [1000,1500,2000,2500])result=engine.update({heading:null,smile:null,
      deskRest:{active:true,confidence:.4,personConfidence:.13,observedAt:at}},at);
    expect(find(result!,'upper_body_slumped').state).toBe('confirmed');
    expect(result!.calibration.reference).toBe('camera');
  });
  it('does not let an appearance cue override a clear upright pose or accumulate from a repeated timestamp',()=>{
    const engine=new PostureBehavior(1000);
    for(const at of [1000,1500,2000,2500]){
      const sample={...input(at),deskRest:{active:true,confidence:.8,personConfidence:.2,observedAt:at}};
      expect(find(engine.update(sample,at),'upper_body_slumped').state).toBe('clear');
    }
    const repeated=new PostureBehavior(1000);
    const sample={heading:null,smile:null,deskRest:{active:true,confidence:.4,personConfidence:.13,observedAt:1000}};
    repeated.update(sample,1000);
    expect(find(repeated.update(sample,2700),'upper_body_slumped').state).toBe('pending');
  });
  it('cannot renew stale independent-person evidence using new appearance timestamps',()=>{
    const engine=new PostureBehavior(1000);
    const sample=(at:number)=>({heading:null,smile:null,deskRest:{active:true,confidence:.4,
      personConfidence:.15,personObservedAt:1000,candidateConfidence:.04,observedAt:at}});
    engine.update(sample(1000),1000);
    expect(find(engine.update(sample(2500),2500),'upper_body_slumped').state).toBe('confirmed');
    expect(find(engine.update(sample(3001),3001),'upper_body_slumped').state).toBe('unavailable');
  });
  it('uses camera direction immediately and never learns a held sideways posture as normal',()=>{
    const engine=new PostureBehavior(1000);
    expect(engine.update(input(1000,35),1000).calibration).toMatchObject({state:'ready',reference:'camera'});
    for(let at=1500;at<=33000;at+=500)engine.update(input(at,35),at);
    expect(find(engine.update(input(33500,35),33500),'head_turned').state).toBe('confirmed');
  });
  it('has no calibration deadline and still requires fresh evidence rather than repeated replies',()=>{
    const engine=new PostureBehavior(1000);
    engine.update({heading:null,smile:null},1000);
    for(let at=22000;at<35000;at+=500){
      const result=engine.update(input(at,40),at);
      expect(result.calibration.headingReady).toBe(true);
      if(at>=24000)expect(find(result,'head_turned').state).toBe('confirmed');
    }
    const duplicate=new PostureBehavior(1000);
    for(let now=1000;now<3000;now+=100)expect(find(duplicate.update(input(1000,40),now),'head_turned').state).toBe('pending');
  });
  it('supports a configured camera heading without learning from students',()=>{
    const engine=new PostureBehavior(1000,30);
    expect(find(engine.update(input(1000,30),1000),'head_turned').state).toBe('clear');
    engine.update(input(2000,-10),2000);
    expect(find(engine.update(input(4000,-10),4000),'head_turned').state).toBe('confirmed');
  });
  it('confirms a single held turn after two seconds, then requires a sustained return',()=>{
    const engine=calibrated();
    for(const at of [14000,14500,15000,15500])expect(find(engine.update(input(at,35),at),'head_turned').state).toBe('pending');
    expect(find(engine.update(input(16000,35),16000),'head_turned').state).toBe('confirmed');
    expect(find(engine.update(input(16500,10),16500),'head_turned').state).toBe('confirmed');
    expect(find(engine.update(input(17100,10),17100),'head_turned').state).toBe('clear');
  });
  it('does not combine dwell time across different measurement sources',()=>{
    const engine=new PostureBehavior(1000);engine.update(input(1000,35),1000);
    const sample=input(2500,45);sample.heading.source='body_keypoints';
    expect(find(engine.update(sample,2500),'head_turned').state).toBe('pending');
  });
  it('distinguishes head-only turns, combined torso turns and an ambiguous tilted body',()=>{
    const engine=calibrated();
    for(let at=14000;at<=16000;at+=500)engine.update(input(at,35),at);
    expect(find(engine.update(input(16500,35),16500),'torso_turned').state).toBe('clear');
    let result=engine.update(input(17000,35,'turn'),17000);
    for(let at=17500;at<=19000;at+=500)result=engine.update(input(at,35,'turn'),at);
    expect(find(result,'torso_turned').state).toBe('confirmed');
    const tilted=input(19500,35,'turn');tilted.pose.keypoints[5].y=.25;
    expect(find(engine.update(tilted,19500),'torso_turned').state).toBe('unavailable');
  });
  it('only confirms smiling in combination with a confirmed held turn',()=>{
    const engine=calibrated();
    for(let at=14000;at<=16000;at+=500){
      const sample=input(at);sample.smile={left:.8,right:.8,at};
      expect(find(engine.update(sample,at),'turned_smiling').state).toBe('clear');
    }
    for(let at=16500;at<=18500;at+=500)engine.update(input(at,35),at);
    const smile=(at:number)=>{const sample=input(at,35);sample.smile={left:.8,right:.8,at};return engine.update(sample,at);};
    expect(find(smile(19000),'turned_smiling').state).toBe('pending');
    expect(find(smile(19500),'turned_smiling').state).toBe('confirmed');
  });
  it('detects upper-body slump independently from face and experimental action models',()=>{
    const engine=calibrated();
    for(let at=14000;at<=15000;at+=500)expect(find(engine.update({...input(at,0,'slump'),heading:null,smile:null},at),'upper_body_slumped').state).toBe('pending');
    expect(find(engine.update({...input(15500,0,'slump'),heading:null,smile:null},15500),'upper_body_slumped').state).toBe('confirmed');
  });
  it('uses stable elbows when hips are occluded and rejects moving elbow references',()=>{
    const engine=calibrated(false);
    let result=engine.update(input(13500,0,'normal',false),13500);
    expect(result.calibration.postureReady).toBe(true);
    for(let at=14000;at<=15500;at+=500)result=engine.update(input(at,0,'slump',false),at);
    expect(find(result,'upper_body_slumped').state).toBe('confirmed');
    const moved=input(16000,0,'slump',false);moved.pose.keypoints[7].y=.9;moved.pose.keypoints[8].y=.9;
    expect(find(engine.update(moved,16000),'upper_body_slumped').state).toBe('unavailable');
  });
  it('does not treat reading, missing face or a single visible shoulder as a slump',()=>{
    const engine=calibrated();
    for(let at=14000;at<=17000;at+=500)expect(find(engine.update({...input(at,0,'read'),pitch:30},at),'upper_body_slumped').state).toBe('clear');
    const missing=input(17500);missing.pose.keypoints[5].confidence=0;
    expect(find(engine.update(missing,17500),'upper_body_slumped').state).toBe('unavailable');
    expect(find(engine.update({heading:null,smile:null},18000),'upper_body_slumped').state).toBe('unavailable');
  });
  it('rejects stale, future, repeated and out-of-order evidence',()=>{
    const engine=calibrated();engine.update(input(14000,35),14000);
    expect(find(engine.update(input(14000,35),15000),'head_turned').state).toBe('pending');
    expect(find(engine.update(input(13900,35),15000),'head_turned').state).toBe('unavailable');
    expect(find(engine.update(input(15500,35),15000),'head_turned').state).toBe('unavailable');
    expect(find(engine.update(input(14000,35),18000),'head_turned').state).toBe('unavailable');
  });
});

function track(at:number,kind:'normal'|'slump'='normal',personId=7):StudentTrack{
  return {id:'A',displayName:'A',color:'',lastSeen:at,status:'visible',personId,boxKind:'person',
    box:{x:.1,y:.1,width:.7,height:.85},faceVisibility:'visible',
    observation:{valid:true,eyeAspectRatio:.3,yawOffset:0,yawDeg:0,pitchDeg:0,observedAt:at,
      bodyPose:pose(at,kind),bookInteraction:true,objectsAt:at}};
}
describe('posture integration and lifecycle',()=>{
  it('publishes the slump alert on a body with no face or pose when two-model temporal evidence is fresh',()=>{
    const evaluator=new AttentionEvaluator();let result:StudentTrack;
    for(const at of [1000,1500,2000,2500]){
      const sample=track(at);sample.faceVisibility='unavailable';
      sample.observation={valid:false,eyeAspectRatio:0,yawOffset:0,observedAt:at,
        deskRest:{active:true,confidence:.45,personConfidence:.04,candidateConfidence:.04,temporalPerson:true,personObservedAt:at-500,observedAt:at}};
      result=evaluator.evaluate([sample],at)[0];
    }
    expect(result!.alerts![0].type).toBe('upper_body_slumped');
    expect(result!.attention).toBe('needs_attention');
    expect(result!.signals!.find(s=>s.type==='eyes_closed')!.state).toBe('unavailable');
  });
  it('flags a slump even with book context and without a face; holds the alert without renewing old evidence',async()=>{
    const {defaultObservationSettings}=await import('../src/observation-settings.js');
    const evaluator=new AttentionEvaluator({...defaultObservationSettings(),objectsEnabled:true});
    for(let at=1000;at<=13000;at+=500)evaluator.evaluate([track(at)],at);
    let result:StudentTrack;
    for(let at=14000;at<=15500;at+=500){
      const sample=track(at,'slump');sample.faceVisibility='unavailable';sample.observation!.valid=false;
      result=evaluator.evaluate([sample],at)[0];
    }
    expect(result!.studyContext).toBe('book');
    expect(result!.alerts![0].type).toBe('upper_body_slumped');
    expect(result!.attention).toBe('needs_attention');
    const unknown=track(16000);unknown.faceVisibility='unavailable';unknown.observation=undefined;
    expect(evaluator.evaluate([unknown],16000)[0].alerts![0]).toMatchObject({held:true,expiresAt:20500});
    expect(evaluator.evaluate([{...unknown,lastSeen:21000}],21000)[0].alerts).toEqual([]);
  });
  it('starts with a camera reference when identity changes or a track reappears',()=>{
    const evaluator=new AttentionEvaluator();
    for(let at=1000;at<=13000;at+=500)evaluator.evaluate([track(at)],at);
    expect(evaluator.evaluate([track(14000)],14000)[0].calibration!.headingReady).toBe(true);
    expect(evaluator.evaluate([track(14500,'normal',8)],14500)[0].calibration!.reference).toBe('camera');
    evaluator.evaluate([],15000);
    expect(evaluator.evaluate([track(15500)],15500)[0].calibration!.reference).toBe('camera');
  });
  it('rotates AI context and clears references on a camera-source switch, retaining the HTTP session',async()=>{
    let now=1000;const sessions=new Sessions(()=>now);const id=sessions.create();
    const contexts:string[]=[];const release=vi.fn();
    const engine:InferenceEngine={ready:true,close:async()=>{},release,detect:async(_jpeg,context)=>{
      contexts.push(context!.sessionId);return [track(now)];
    }};
    for(now=1000;now<=13000;now+=500)await sessions.detect(id,Buffer.from('x'),engine);
    now=14000;const before=await sessions.detect(id,Buffer.from('x'),engine);
    expect(before[0].calibration!.headingReady).toBe(true);
    now=14500;const after=await sessions.detect(id,Buffer.from('x'),engine,'pi');
    expect(after[0].calibration!.reference).toBe('camera');
    expect(contexts.at(-1)).not.toBe(id);expect(release).toHaveBeenCalledWith(id);
    sessions.delete(id,engine);expect(release).toHaveBeenCalledWith(contexts.at(-1));
  });
  it('confirms desk slump when head drops clearly below shoulders even if hips and elbows are occluded under the desk',()=>{
    const engine=new PostureBehavior(1000);
    const deskSlumpPose=(at:number):BodyPose=>{
      const keypoints=Array.from({length:17},()=>({x:.5,y:.8,confidence:0}));
      keypoints[0]={x:.5,y:.62,confidence:.9};
      keypoints[5]={x:.3,y:.50,confidence:.9};keypoints[6]={x:.7,y:.50,confidence:.9};
      return {box:{x:.15,y:.2,width:.7,height:.7},aspectRatio:1,keypoints,confidence:.85,observedAt:at,source:'YOLO11n-pose'};
    };
    let result:ReturnType<PostureBehavior['update']>;
    for(const at of [1000,1500,2000,2600])result=engine.update({heading:null,smile:null,pose:deskSlumpPose(at)},at);
    expect(find(result!,'upper_body_slumped').state).toBe('confirmed');
  });
  it('detects seated torso_turned when hips/elbows are under the desk and turned_smiling with asymmetric profile smile',()=>{
    const engine=new PostureBehavior(1000);
    const seated=(at:number,lsX:number,rsX:number):BodyPose=>{
      const keypoints=Array.from({length:17},()=>({x:.5,y:.8,confidence:0}));
      keypoints[0]={x:.5,y:.25,confidence:.9};
      keypoints[5]={x:lsX,y:.45,confidence:.9};keypoints[6]={x:rsX,y:.45,confidence:.9};
      return {box:{x:.2,y:.15,width:.6,height:.7},aspectRatio:1,keypoints,confidence:.9,observedAt:at,source:'YOLO11n-pose'};
    };
    // Learn frontal shoulder width facing camera, then turn sideways with narrowed shoulders and asymmetric smile.
    for(const at of [1000,1400,1800])engine.update({heading:{value:0,source:'face_pose',at},pose:seated(at,.68,.32),smile:{left:0,right:0,at}},at);
    let result:ReturnType<PostureBehavior['update']>;
    for(const at of [2200,2800,3400,4000,4600,5200]){
      result=engine.update({heading:{value:48,source:'face_pose',at},pose:seated(at,.58,.42),smile:{left:.68,right:.34,at}},at);
    }
    expect(find(result!,'head_turned').state).toBe('confirmed');
    expect(find(result!,'torso_turned').state).toBe('confirmed');
    expect(find(result!,'turned_smiling').state).toBe('confirmed');
  });
});
