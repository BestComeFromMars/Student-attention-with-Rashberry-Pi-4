import {describe,it,expect} from 'vitest';
import {bodyYawDegrees} from '../src/camera-direction.js';
import {PostureBehavior} from '../src/posture-behavior.js';
import {HeadMotion} from '../src/head-motion.js';
import {AttentionEvaluator} from '../src/attention.js';
import {StudentTracker} from '../src/tracker.js';
import type {StudentTrack,DetectedPerson} from '../src/types.js';

describe('per-person camera direction and independent evidence sources',()=>{
  it('allows sustained small neck turns and small repeated movements, while retaining clear sideways warnings',()=>{
    const posture=new PostureBehavior(1000),motion=new HeadMotion();
    let at=1000;
    for(const yaw of [0,20,-20,30,-30,10,0])for(let n=0;n<6;n++,at+=400){
      const result=posture.update({heading:{value:yaw,source:'face_pose',at},smile:null},at);
      expect(result.signals.find(s=>s.type==='head_turned')!.state).toBe('clear');
      expect(motion.update(yaw/90,at,at,'face_pose').cycles).toBe(0);
    }
    for(let n=0;n<6;n++,at+=400)posture.update({heading:{value:45,source:'face_pose',at},smile:null},at);
    expect(posture.update({heading:{value:45,source:'face_pose',at},smile:null},at).signals[0].state).toBe('confirmed');
    at+=400;posture.update({heading:{value:20,source:'face_pose',at},smile:null},at);
    at+=800;expect(posture.update({heading:{value:20,source:'face_pose',at},smile:null},at).signals[0].state).toBe('clear');
  });
  it('does not promote a borderline body-proxy bias into a held camera turn',()=>{
    const engine=new PostureBehavior(1000);
    for(const at of [1000,1800,2600,3400]){
      const result=engine.update({heading:{value:28,source:'body_keypoints',at},smile:null},at);
      expect(result.signals.find(s=>s.type==='head_turned')!.state).toBe('clear');
    }
    engine.update({heading:{value:42,source:'body_keypoints',at:5000},smile:null},5000);
    let result:ReturnType<PostureBehavior['update']>;
    for(const at of [5800,6600,7400])result=engine.update({heading:{value:38,source:'body_keypoints',at},smile:null},at);
    expect(result!.signals.find(s=>s.type==='head_turned')!.state).toBe('confirmed','a strong body-proxy start may continue above the configured 35 degree boundary');
  });
  it('corrects the observed COCO/face sign disagreement without treating the proxy as degrees',()=>{
    expect(bodyYawDegrees(0)).toBe(0);
    expect(bodyYawDegrees(.4)).toBeLessThan(-35);
    expect(bodyYawDegrees(-.4)).toBeGreaterThan(35);
    expect(Math.abs(bodyYawDegrees(1))).toBeLessThan(90);
  });
  it('retains each sources own held turn while face/pose sources alternate',()=>{
    const behavior=new PostureBehavior(1000);let result:ReturnType<PostureBehavior['update']>;
    for(let i=0;i<8;i++){
      const at=1000+i*700;result=behavior.update({heading:{value:45,source:i%2?'body_keypoints':'face_pose',at},smile:null},at);
    }
    expect(result!.signals.find(s=>s.type==='head_turned')!.state).toBe('confirmed');
  });
  it('never adds two face changes to a body-source change to fabricate three turns',()=>{
    const motion=new HeadMotion();
    const sample=(yaw:number,at:number,source:string)=>{motion.update(yaw,at,at,source);return motion.update(yaw,at+150,at+150,source);};
    sample(0,1000,'face');sample(-.4,1500,'face');expect(sample(0,2000,'face').cycles).toBe(2);
    sample(0,2200,'body');expect(sample(.4,2700,'body')).toMatchObject({cycles:1,state:'pending'});
    expect(sample(.4,3000,'face').cycles).toBe(3);
  });
  it('uses measured small-face orientation without inventing eye or speech detail',()=>{
    const evaluator=new AttentionEvaluator();let result:StudentTrack;
    for(const at of [1000,1700,2400,3100]){
      result=evaluator.evaluate([{id:'A',displayName:'A',color:'',status:'visible',lastSeen:at,
        faceVisibility:'visible',box:{x:.2,y:.2,width:.1,height:.1},observation:{valid:false,headPoseValid:true,
          eyeValid:false,facePixels:35,eyeAspectRatio:0,yawOffset:0,yawDeg:35,pitchDeg:22,observedAt:at}}],at)[0];
    }
    expect(result!.signals!.find(s=>s.type==='head_turned')!.state).toBe('confirmed');
    expect(result!.signals!.find(s=>s.type==='head_down')!.state).toBe('confirmed');
    expect(result!.signals!.find(s=>s.type==='eyes_closed')!.state).toBe('unavailable');
    expect(result!.signals!.find(s=>s.type==='talking')!.state).toBe('unavailable');
  });
  it('uses newer head keypoints instead of repeatedly publishing an older face pose',()=>{
    const evaluator=new AttentionEvaluator();
    const observation={valid:true,eyeAspectRatio:.3,yawOffset:0,yawDeg:0,observedAt:1000,
      headYaw:-.5,headObservedAt:1000,headSource:'body_keypoints' as const};
    const track:StudentTrack={id:'A',displayName:'A',color:'',status:'visible',lastSeen:1000,
      faceVisibility:'visible',box:{x:.2,y:.2,width:.1,height:.1},observation};
    const warning=(now:number)=>evaluator.evaluate([track],now)[0].signals!.find(signal=>signal.type==='head_turned');
    expect(warning(1000)?.state).toBe('clear');
    observation.headObservedAt=1800;
    expect(warning(1800)).toMatchObject({state:'pending',observedAt:1800});
    expect(warning(2000)).toMatchObject({state:'pending',durationMs:0});
  });
  it('clears stale face ownership when a body loses its face, and keeps the body ID through a face-only alias',()=>{
    const tracker=new StudentTracker(),box={x:.2,y:.2,width:.2,height:.5};
    const person:DetectedPerson={personId:7,geometryId:10,box,personBox:box,faceBox:{x:.23,y:.21,width:.05,height:.06},
      boxKind:'person',faceVisibility:'visible',trackingState:'face'};
    const first=tracker.update([person],1000)[0];
    const hidden={...person,geometryId:undefined,faceBox:undefined,faceVisibility:'unavailable' as const,trackingState:'visual' as const};
    expect(tracker.update([hidden],1500)[0].geometryId).toBeUndefined();
    const alias={...person,personId:undefined,personBox:undefined,box:person.faceBox!,boxKind:'face' as const,geometryId:20};
    tracker.update([hidden,alias],2000);
    const result=tracker.update([{...person,geometryId:20}],2500).filter(t=>t.status==='visible');
    expect(result).toHaveLength(1);expect(result[0].id).toBe(first.id);
  });
  it('confirms repeated left-right head turns at live AI cadence even when profile_roi takes over at side angles',()=>{
    const evaluator=new AttentionEvaluator();
    let result:StudentTrack;
    // Live ~250ms cadence: frontal (face_landmarker) -> left profile (profile_roi) -> right profile -> left profile.
    const samples:[number,number,'face_landmarker'|'profile_roi'][]=[
      [1000,0,'face_landmarker'],[1250,0,'face_landmarker'],
      [1500,-42,'profile_roi'],[1750,-42,'profile_roi'],
      [2050,42,'profile_roi'],
      [2350,-42,'profile_roi'],
    ];
    for(const [at,yawDeg,mouthSource] of samples){
      result=evaluator.evaluate([{id:'A',displayName:'A',color:'',status:'visible',lastSeen:at,
        faceVisibility:'visible',box:{x:.2,y:.2,width:.2,height:.25},observation:{valid:mouthSource==='face_landmarker',
          headPoseValid:true,facePixels:90,mouthSource,eyeAspectRatio:.3,yawOffset:Math.abs(yawDeg)/90,yawDeg,pitchDeg:0,observedAt:at}}],at)[0];
    }
    expect(result!.signals!.find(s=>s.type==='head_turning')).toMatchObject({state:'confirmed',cycles:3});
  });
});
