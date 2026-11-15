import {describe,it,expect} from 'vitest';
import {FacialBehavior} from '../src/facial-behavior.js';
import {AttentionEvaluator} from '../src/attention.js';
import {SpeechMotion} from '../src/speech-motion.js';
import {defaultObservationSettings} from '../src/observation-settings.js';
import type {FaceObservation,StudentTrack} from '../src/types.js';

const settings=()=>({...defaultObservationSettings().thresholds,talkingMs:500,talkingCycles:3});
function observation(at:number,mouth:number,extra:Partial<FaceObservation>={}):FaceObservation{
  return {valid:true,mouthValid:true,facePixels:120,mouthSource:'face_landmarker',eyeAspectRatio:.3,yawOffset:0,yawDeg:0,pitchDeg:0,
    mouthOpenRatio:mouth,observedAt:at,...extra};
}
function track(o:FaceObservation):StudentTrack{return {id:'A',displayName:'A',color:'',status:'visible',personId:7,lastSeen:o.observedAt!,
  faceVisibility:'visible',boxKind:'face',box:{x:.2,y:.2,width:.3,height:.4},observation:o};}
function articulate(face:FacialBehavior,start=1000){
  let result:ReturnType<FacialBehavior['update']>;
  for(const [offset,mouth]of [[0,.04],[100,.16],[250,.04],[400,.16],[550,.04],[700,.16],[850,.04]]){
    result=face.update(observation(start+offset,mouth),start+offset,true);
  }
  return result!;
}
describe('speech evidence freshness and noise controls',()=>{
  it('does not call an open-eyed moderate speech vowel a yawn, but retains a sustained wide yawn',()=>{
    const face=new FacialBehavior();
    for(let at=1000;at<=2200;at+=200){
      const result=face.update(observation(at,.4,{jawOpen:.6,eyeBlinkLeft:.05,eyeBlinkRight:.05}),at,true);
      expect(result.yawn).toBe(false);
    }
    expect(face.update(observation(2400,.8,{jawOpen:.8}),2400,true).yawn).toBe(true);
    expect(face.update(observation(3000,.8,{jawOpen:.8}),3000,true).yawn).toBe(true);
  });
  it('still confirms real-sized repeated mouth motion with configured thresholds',()=>{
    expect(articulate(new FacialBehavior(settings())).talking).toMatchObject({state:'confirmed',observedAt:1850});
  });
  it('does not classify small lip and jaw landmark jitter as speaking',()=>{
    const face=new FacialBehavior(settings());
    for(let at=1000;at<9000;at+=100){
      const mouth=at%200?.09:.05,jaw=at%200?.14:.07;
      const result=face.update(observation(at,mouth,{jawOpen:jaw}),at,true);
      expect(result.talking.state).not.toBe('confirmed');expect(result.mouthCycles).toBe(0);
    }
  });
  it('never renews a speech alert from fresh static mouth replies after cycles completed',()=>{
    const config=defaultObservationSettings();Object.assign(config.thresholds,settings());
    const evaluator=new AttentionEvaluator(config);let result:StudentTrack;
    for(const [at,mouth]of [[1000,.04],[1100,.16],[1250,.04],[1400,.16],[1550,.04],[1700,.16],[1850,.04]])
      result=evaluator.evaluate([track(observation(at,mouth))],at)[0];
    const expiry=result!.alerts!.find(a=>a.type==='talking')!.expiresAt;
    for(let at=1950;at<=7500;at+=100){
      result=evaluator.evaluate([track(observation(at,.04))],at)[0];
      const alert=result.alerts!.find(a=>a.type==='talking');
      if(alert)expect(alert.expiresAt).toBe(expiry);
      if(at>2300)expect(result.signals!.find(s=>s.type==='talking')!.state).toBe('clear');
    }
    expect(result!.alerts!.some(a=>a.type==='talking')).toBe(false);
  });
  it('does not combine a remote first cycle with unrelated recent cycles',()=>{
    const motion=new SpeechMotion(settings());
    motion.update(.04,null,0);motion.update(.16,null,100);motion.update(.04,null,300);
    // Keep weak activity fresh; the first completed cycle must still age out.
    for(let at=500;at<=5000;at+=500)motion.update(at%1000?.11:.04,null,at);
    motion.update(.16,null,5200);motion.update(.04,null,5400);
    expect(motion.evidence.durationMs).toBeLessThanOrEqual(4900);
  });
  it.each([
    {quality:{usable:false,brightness:10,contrast:2,sharpness:1}},
    {facePixels:45},
  ])('does not count uncertain small or poor image measurements: %o',extra=>{
    const face=new FacialBehavior(settings());
    for(let at=1000;at<5000;at+=150){
      const result=face.update(observation(at,at%300?.18:.04,extra),at,true);
      expect(result.talking.state).toBe('unavailable');expect(result.mouthCycles).toBe(0);
    }
  });
  it('resets speech accumulation on head-pose jumps and accepts stable profile measurements afterwards',()=>{
    const face=new FacialBehavior(settings());
    face.update(observation(1000,.04),1000,true);
    for(const [at,mouth,yaw]of [[1100,.16,15],[1250,.04,0],[1400,.16,15],[1550,.04,0],[1700,.16,15],[1850,.04,0]])
      expect(face.update(observation(at,mouth,{yawDeg:yaw}),at,true).talking.state).toBe('unavailable');
    let result:ReturnType<FacialBehavior['update']>;
    for(const [at,mouth]of [[2000,.04],[2100,.16],[2250,.04],[2400,.16],[2550,.04],[2700,.16],[2850,.04]])
      result=face.update(observation(at,mouth,{yawDeg:45,valid:false,mouthSource:'profile_roi'}),at,false,true);
    expect(result!.talking.state).toBe('confirmed');
  });
  it.each([{mouthSmileLeft:.6,mouthSmileRight:.35},{mouthOpenRatio:.8}])('blocks moderate smiles and yawns: %o',extra=>{
    const face=new FacialBehavior(settings());
    for(let at=1000;at<6000;at+=150)
      expect(face.update(observation(at,at%300?.18:.04,extra),at,true).talking.state).toBe('clear');
  });
  it('does not accumulate from repeated timestamps or mix landmark sources',()=>{
    const face=new FacialBehavior(settings());
    face.update(observation(1000,.04),1000,true);face.update(observation(1100,.16),1100,true);
    for(let n=0;n<10;n++)expect(face.update(observation(1100,n%2?.04:.16),1100,true).mouthCycles).toBe(0);
    expect(face.update(observation(1250,.04,{mouthSource:'profile_roi'}),1250,true).mouthCycles).toBe(0);
  });
  it('supports a configured speech duration longer than the default evidence window',()=>{
    const thresholds={...settings(),talkingMs:6000},face=new FacialBehavior(thresholds);
    let result:ReturnType<FacialBehavior['update']>;
    for(let at=1000;at<=8000;at+=200)result=face.update(observation(at,at%400?.16:.04),at,true);
    expect(result!.talking.state).toBe('confirmed');
  });
});
