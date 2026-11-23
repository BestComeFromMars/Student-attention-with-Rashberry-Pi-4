import {describe,it,expect} from 'vitest';
import {AttentionEvaluator} from '../src/attention.js';
import {StudentTracker} from '../src/tracker.js';
import {HeadMotion} from '../src/head-motion.js';
import {defaultObservationSettings} from '../src/observation-settings.js';
import type {StudentTrack} from '../src/types.js';

function person(at:number,yaw:number|null=0,identity=7):StudentTrack {
  return {id:'A',displayName:'A',color:'',box:{x:.1,y:.1,width:.3,height:.7},boxKind:'person',
    personId:identity,status:'visible',lastSeen:at,faceVisibility:yaw===null?'unavailable':'visible',
    observation:{valid:yaw!==null,facePresent:yaw!==null,eyeAspectRatio:.3,yawOffset:0,yawDeg:yaw,
      pitchDeg:0,mouthOpenRatio:.05,observedAt:at,phoneHeld:false,laptopInteraction:false,objectsAt:at}};
}
function move(head:HeadMotion,yaw:number,at:number,source='face') {
  head.update(yaw,at,at,source);
  return head.update(yaw,at+150,at+150,source);
}

describe('head motion with fresh per-person evidence',()=>{
  it('keeps a small face/body while withholding unsupported eyelid claims',()=>{
    const evaluator=new AttentionEvaluator();let result:StudentTrack|undefined;
    for(const at of [1000,1400,1800,2200]){
      const input=person(at);Object.assign(input.observation!,{eyeValid:false,eyeAspectRatio:.05,
        eyeBlinkLeft:.9,eyeBlinkRight:.9,pitchDeg:25});
      result=evaluator.evaluate([input],at)[0];
    }
    expect(result!.signals!.find(s=>s.type==='eyes_closed')!.state).toBe('unavailable');
    expect(result!.alerts!.some(a=>a.type==='eyes_closed')).toBe(false);
    expect(result!.signals!.find(s=>s.type==='head_down')!.state).toBe('confirmed');
    expect(result!.box).toEqual(person(2200).box);
  });
  it('confirms three sustained direction changes within ten seconds',()=>{
    const head=new HeadMotion();
    move(head,0,1000);move(head,-.4,1500);move(head,0,2000);
    expect(move(head,.4,2500)).toMatchObject({state:'confirmed',cycles:3});
  });
  it('rejects jitter, a single turn, short spikes and repeated replies',()=>{
    const head=new HeadMotion();move(head,0,1000);
    for(let at=1300;at<2300;at+=100)head.update(at%200?-.18:.18,at,at,'face');
    head.update(.4,2400,2400,'face');head.update(0,2450,2450,'face');
    expect(move(head,.4,2700).cycles).toBe(1);
    for(let now=2900;now<3500;now+=100)expect(head.update(.4,2850,now,'face').cycles).toBe(1);
  });
  it('preserves completed changes across a brief missing face without counting the loss',()=>{
    const head=new HeadMotion();move(head,0,1000);move(head,-.4,1500);
    expect(head.update(null,1900,1900)).toMatchObject({state:'unavailable',cycles:1});
    move(head,0,2200);
    expect(move(head,.4,2700)).toMatchObject({state:'confirmed',cycles:3});
  });
  it('expires old evidence and resets after long gaps',()=>{
    const head=new HeadMotion();move(head,0,1000);move(head,-.4,1500);
    expect(head.update(null,5000,5000).cycles).toBe(0);
    expect(move(head,.4,5200)).toMatchObject({state:'clear',cycles:0});
  });
  it('does not count changes in measurement source as head movements',()=>{
    const head=new HeadMotion();move(head,-.4,1000);
    expect(move(head,.4,1500,'body_keypoints').cycles).toBe(0);
    expect(head.update(-.4,1200,1800,'face').state).toBe('unavailable');
    expect(head.update(.4,1950,5000,'body_keypoints').state).toBe('unavailable');
  });
});

describe('observation-only behavior evaluation',()=>{
  it('never infers concentration from a stable face or a legacy score',()=>{
    const evaluator=new AttentionEvaluator();
    for(let at=1000;at<10000;at+=200){
      const input=person(at);input.observation!.cavtScore=.99;
      const result=evaluator.evaluate([input],at)[0];
      expect(result.attention).toBe('uncertain');
      expect(result.reason).not.toMatch(/tập trung/i);
    }
  });
  it('detects head turns without facial measurements from fresh head keypoints',()=>{
    const evaluator=new AttentionEvaluator();
    let result:StudentTrack;
    for(const [at,yaw] of [[1000,0],[1500,-.4],[2000,0],[2500,.4]]){
      for(const stamp of [at,at+150]){
        const input=person(stamp,null);
        Object.assign(input.observation!,{headYaw:yaw,headObservedAt:stamp,headSource:'body_keypoints'});
        result=evaluator.evaluate([input],stamp)[0];
      }
    }
    expect(result!.signals!.find(s=>s.type==='head_turning')).toMatchObject({state:'confirmed',cycles:3});
    expect(result!.signals!.find(s=>s.type==='eyes_closed')!.state).toBe('unavailable');
    expect(result!.alerts!.some(s=>s.type==='head_turning')).toBe(true);
  });
  it('retains head history on body tracking through face loss and reacquisition',()=>{
    const evaluator=new AttentionEvaluator();
    const run=(yaw:number,at:number)=>{
      evaluator.evaluate([person(at,yaw)],at);
      return evaluator.evaluate([person(at+150,yaw)],at+150)[0];
    };
    run(0,1000);run(-35,1500);
    evaluator.evaluate([person(1900,null)],1900);
    run(0,2200);
    expect(run(35,2700).signals!.find(s=>s.type==='head_turning')!.state).toBe('confirmed');
  });
  it('does not carry head-turn history to a different person or a new session',()=>{
    const evaluator=new AttentionEvaluator();
    for(const [at,yaw] of [[1000,0],[1500,-35],[2000,0]]){
      evaluator.evaluate([person(at,yaw)],at);evaluator.evaluate([person(at+150,yaw)],at+150);
    }
    evaluator.evaluate([person(2500,35,8)],2500);
    expect(evaluator.evaluate([person(2650,35,8)],2650)[0].signals!.find(s=>s.type==='head_turning')!.cycles).toBe(0);
    expect(new AttentionEvaluator().evaluate([person(2800,35)],2800)[0].alerts).toEqual([]);
  });
  it('uses lower confirmation durations but never accumulates repeated timestamps',()=>{
    const settings=defaultObservationSettings();settings.objectsEnabled=true;settings.enabled.phone=true;
    const evaluator=new AttentionEvaluator(settings);
    const sample=(at:number,now=at)=>{
      const input=person(at);Object.assign(input.observation!,{phoneHeld:true,eyeAspectRatio:.05,pitchDeg:20});
      return evaluator.evaluate([input],now)[0];
    };
    sample(1000);
    expect(sample(1000,1800).signals!.find(s=>s.type==='phone')!.state).toBe('pending');
    expect(sample(1400).signals!.find(s=>s.type==='phone')!.state).toBe('confirmed');
    const result=sample(1800);
    expect(result.signals!.find(s=>s.type==='eyes_closed')!.state).toBe('confirmed');
    expect(result.signals!.find(s=>s.type==='head_down')!.state).toBe('confirmed');
  });
  it('retains a confirmed warning for five seconds through a missing face, without renewing it',()=>{
    const evaluator=new AttentionEvaluator();
    for(const at of [1000,1800]){
      const input=person(at);input.observation!.eyeAspectRatio=.05;evaluator.evaluate([input],at);
    }
    expect(evaluator.evaluate([person(2100,null)],2100)[0].alerts).toContainEqual(expect.objectContaining({type:'eyes_closed',held:true,expiresAt:6800}));
    expect(evaluator.evaluate([person(6900,null)],6900)[0].alerts).toEqual([]);
  });
  it('requires three actual mouth cycles over the default duration',()=>{
    const evaluator=new AttentionEvaluator();
    let result:StudentTrack;
    for(const [at,mouth] of [[1000,.05],[1200,.15],[1500,.05],[1700,.15],[2100,.05],[2400,.15],[2800,.05]]){
      const input=person(at);input.observation!.mouthOpenRatio=mouth;
      result=evaluator.evaluate([input],at)[0];
      if(at<2800)expect(result.signals!.find(s=>s.type==='talking')!.state).not.toBe('confirmed');
    }
    expect(result!.signals!.find(s=>s.type==='talking')).toMatchObject({state:'confirmed',cycles:3,durationMs:1600});
  });
  it('keeps the same ID when the face vanishes and a new face geometry returns on the same body',()=>{
    const tracker=new StudentTracker();
    const first=person(1000);first.geometryId=3;
    expect(tracker.update([first],1000)[0].id).toBe('A');
    expect(tracker.update([person(1500,null)],1500)[0]).toMatchObject({id:'A',status:'visible'});
    const returned=person(2000);returned.geometryId=9;
    expect(tracker.update([returned],2000)[0].id).toBe('A');
    const replacement=person(2200,null,8);
    expect(tracker.update([replacement],2200).find(t=>t.personId===8)!.id).toBe('B');
  });
  it('keeps a display ID through body reacquisition only with the same fresh overlapping face',()=>{
    const tracker=new StudentTracker();
    const body={x:.1,y:.1,width:.3,height:.7},face={x:.16,y:.14,width:.1,height:.15};
    const first={...person(1000),boxKind:'person' as const,box:body,personBox:body,faceBox:face,geometryId:3,trackingState:'face' as const};
    expect(tracker.update([first],1000)[0].id).toBe('A');
    const reacquired={...first,personId:8,faceBox:{...face,x:.165}};
    expect(tracker.update([reacquired],1500).find(t=>t.status==='visible')).toMatchObject({id:'A',personId:8});
    const hidden={...reacquired,personId:9,faceVisibility:'unavailable' as const,faceBox:undefined};
    expect(tracker.update([hidden],1600).find(t=>t.status==='visible')).toMatchObject({id:'B',personId:9});
  });
});
