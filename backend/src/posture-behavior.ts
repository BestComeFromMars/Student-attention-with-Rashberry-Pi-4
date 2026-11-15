import type {BehaviorSignal,BodyPose,ObservationCalibration,DeskRestObservation} from './types.js';
import {defaultObservationSettings,type ObservationSettings} from './observation-settings.js';

const GAP=2000;
type Point={x:number;y:number};
type Features={mode:'hips'|'elbows';at:number;widthRatio:number;heightRatio:number;tilt:number;slope:number;headLow:boolean|null};
export interface PostureInput {
  heading:{value:number;source:string;at:number}|null;
  pose?:BodyPose;
  pitch?:number|null;
  smile:{left:number;right:number;at:number}|null;
  deskRest?:DeskRestObservation;
}
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const fresh=(at:number,now:number)=>finite(at)&&0<=now-at&&now-at<=GAP;
const middle=(a:Point,b:Point):Point=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);

/** Missing samples interrupt a dwell; duplicate replies cannot confirm or release it. */
class Dwell {
  private at=-Infinity;
  private since:number|null=null;
  private release:number|null=null;
  private samples=0;
  private confirmed=false;
  private active=false;
  get accumulating(){return this.since!==null&&this.active;}
  reset(){this.at=-Infinity;this.since=this.release=null;this.samples=0;this.confirmed=this.active=false;}
  update(active:boolean|null,at:number,now:number,required:number,releaseMs=0){
    if(active===null||!fresh(at,now)||at<this.at){
      this.since=this.release=null;this.samples=0;this.confirmed=false;this.active=false;
      return {state:'unavailable' as const,durationMs:0};
    }
    if(at-this.at>GAP){this.since=this.release=null;this.samples=0;this.confirmed=false;}
    if(at>this.at){
      this.at=at;this.active=active;
      if(active){
        this.release=null;this.since??=at;this.samples++;
        if(this.samples>=2&&at-this.since>=required)this.confirmed=true;
      }else{
        this.release??=at;
        if(!this.confirmed||at-this.release>=releaseMs){this.confirmed=false;this.since=null;this.samples=0;}
      }
    }
    return {state:this.confirmed?'confirmed' as const:this.active?'pending' as const:'clear' as const,
      durationMs:this.since===null?0:this.at-this.since};
  }
}

/** Camera-facing is the reference immediately; no per-student calibration delay. */
export class PostureBehavior {
  // Keep evidence per measurement source. Alternating a valid face pose and
  // body keypoints must neither erase every dwell nor combine unlike samples.
  private readonly directions=new Map<string,{head:Dwell;torso:Dwell;smile:Dwell;turned:boolean}>();
  private readonly slump=new Dwell();
  private elbows:{at:number;point:Point}[]=[];
  private lastElbowAt=-Infinity;
  private readonly cameraYaw:number;
  constructor(private readonly startedAt:number,cameraYaw=0,private readonly thresholds:ObservationSettings['thresholds']=defaultObservationSettings().thresholds){this.cameraYaw=finite(cameraYaw)&&Math.abs(cameraYaw)<=90?cameraYaw:0;}

  private features(pose:BodyPose|undefined,now:number):Features|null {
    if(!pose||!fresh(pose.observedAt,now)||!finite(pose.confidence)||pose.confidence<.25||pose.confidence>1||
      pose.source!=='YOLO11n-pose'||!finite(pose.aspectRatio)||
      pose.aspectRatio<=0||pose.keypoints.length!==17)return null;
    const point=(index:number):Point|null=>{
      const p=pose.keypoints[index];
      return p&&[p.x,p.y,p.confidence].every(finite)&&p.confidence>=.35&&p.confidence<=1&&
        p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1?{x:p.x*pose.aspectRatio,y:p.y}:null;
    };
    const left=point(5),right=point(6);
    if(!left||!right)return null;
    const shoulder=middle(left,right),span=distance(left,right);
    if(span<.02)return null;
    const lh=point(11),rh=point(12),le=point(7),re=point(8),nose=point(0);
    let anchor:Point,mode:Features['mode'];
    if(lh&&rh){anchor=middle(lh,rh);mode='hips';}
    else if(le&&re){
      anchor=middle(le,re);mode='elbows';
      if(pose.observedAt>this.lastElbowAt){
        if(pose.observedAt-this.lastElbowAt>GAP)this.elbows=[];
        this.lastElbowAt=pose.observedAt;
        this.elbows=this.elbows.filter(s=>pose.observedAt-s.at<=GAP*2).slice(-2);
        this.elbows.push({at:pose.observedAt,point:anchor});
      }
      if(this.elbows.length<3||pose.observedAt-this.elbows[0].at<600||
        this.elbows.some(s=>distance(s.point,anchor)>span*.1))return null;
    }else return null;
    const length=distance(shoulder,anchor);
    if(length<.02)return null;
    return {mode,at:pose.observedAt,widthRatio:span/length,heightRatio:(anchor.y-shoulder.y)/span,
      tilt:Math.atan2(Math.abs(anchor.x-shoulder.x),Math.max(0,anchor.y-shoulder.y))*180/Math.PI,
      slope:Math.atan2(Math.abs(left.y-right.y),Math.abs(left.x-right.x))*180/Math.PI,
      headLow:nose?nose.y>=shoulder.y-.15*span:null};
  }

  update(input:PostureInput,now:number):{signals:BehaviorSignal[];calibration:ObservationCalibration}{
    const heading=input.heading&&fresh(input.heading.at,now)&&finite(input.heading.value)&&Math.abs(input.heading.value)<=90?input.heading:null;
    const features=this.features(input.pose,now);
    const source=heading?.source??'unavailable';
    let direction=this.directions.get(source);
    if(!direction){direction={head:new Dwell(),torso:new Dwell(),smile:new Dwell(),turned:false};this.directions.set(source,direction);}
    if(!heading){
      for(const previous of this.directions.values()){
        previous.head.reset();previous.torso.reset();previous.smile.reset();previous.turned=false;
      }
    }
    const difference=heading?Math.abs(heading.value-this.cameraYaw):null;
    // A nose/ear proxy is less precise than the measured face pose. Require
    // extra evidence at the entry boundary, without learning a sideways child
    // as the neutral camera direction. Existing release hysteresis is retained.
    const entryAngle=this.thresholds.headTurnAngleDeg+(source==='body_keypoints'&&!direction.head.accumulating?5:0);
    const away=difference===null?null:direction.turned?difference>this.thresholds.headTurnAngleDeg*.8:difference>=entryAngle;
    const headAt=heading?.at??now;
    const head=direction.head.update(away,headAt,now,this.thresholds.headTurnedMs,600);
    direction.turned=head.state==='confirmed';
    const ref=features?{heightRatio:features.mode==='hips'?1:.5,widthRatio:features.mode==='hips'?1:2,tilt:0,slope:0}:undefined;
    const compressed=features&&ref?features.heightRatio<=ref.heightRatio*this.thresholds.slumpHeightPercent/100:null;
    const tilted=features?features.tilt>=this.thresholds.slumpTiltDeg:null;
    let slumped:boolean|null=null,bodyTurn:boolean|null=null;
    if(features&&ref){
      slumped=(compressed===true&&(features.headLow===true||tilted===true))||
        (tilted===true&&features.headLow===true);
      if(features.headLow===null&&!(compressed===true&&tilted===true))slumped=null;
      if(away!==null){
        const narrowed=features.widthRatio/ref.widthRatio<=this.thresholds.torsoNarrowPercent/100;
        const upright=Math.abs(features.tilt-ref.tilt)<=15&&Math.abs(features.slope-ref.slope)<=12;
        bodyTurn=away&&narrowed&&upright;
        if(narrowed&&!upright)bodyTurn=null;
      }
    }
    const rest=input.deskRest;
    const restImageAt=rest?.imageAt??now;
    const trackedPerson=rest&&finite(rest.personConfirmedAt)&&finite(rest.trackedBodyAt)&&
      rest.personConfirmedAt<=rest.trackedBodyAt&&rest.trackedBodyAt===rest.observedAt&&fresh(rest.trackedBodyAt,restImageAt);
    const restKnown=rest&&fresh(restImageAt,now)&&fresh(rest.observedAt,restImageAt)&&
      (fresh(rest.personObservedAt??rest.observedAt,restImageAt)||trackedPerson)&&
      finite(rest.confidence)&&rest.confidence>=0&&rest.confidence<=1&&finite(rest.personConfidence)&&rest.personConfidence>=0&&rest.personConfidence<=1;
    // Folded people can have a weak general-person score even when two models
    // repeatedly agree on their body. Keep that raw score; use the explicit
    // temporal corroboration rather than pretending it is a strong detection.
    const temporalPerson=rest?.temporalPerson===true&&rest.personObservedAt!==undefined&&rest.personConfidence>=.03&&
      finite(rest.candidateConfidence)&&rest.candidateConfidence>=.03&&rest.candidateConfidence<=1;
    const restPositive=restKnown&&rest.active&&rest.confidence>=this.thresholds.deskRestConfidencePercent/100&&(rest.personConfidence>=.1||temporalPerson||trackedPerson&&rest.personConfidence>=.03);
    const upright=features&&features.headLow===false&&features.tilt<30&&features.heightRatio>(features.mode==='hips'?.65:.33);
    const restAccepted=restPositive&&!upright;
    if(restAccepted)slumped=true;
    const poseAt=restAccepted?rest!.observedAt:features?.at??now;
    const torsoAt=Math.min(headAt,poseAt);
    const smileKnown=input.smile&&fresh(input.smile.at,now)&&[input.smile.left,input.smile.right].every(v=>finite(v)&&v>=0&&v<=1);
    const smiling=smileKnown?input.smile!.left>=this.thresholds.smilePercent/100&&input.smile!.right>=this.thresholds.smilePercent/100:null;
    const smileActive=away===null||head.state==='unavailable'?null:head.state==='confirmed'?smiling:false;
    const smileAt=Math.min(headAt,input.smile?.at??now);
    const signals:BehaviorSignal[]=[
      {type:'head_turned',label:'Quay lệch hướng lâu',...head,observedAt:headAt},
      {type:'torso_turned',label:'Có dấu hiệu quay thân sang bên',...direction.torso.update(bodyTurn,torsoAt,now,this.thresholds.torsoTurnedMs),observedAt:torsoAt},
      {type:'turned_smiling',label:'Quay sang bên kèm cười',...direction.smile.update(smileActive,smileAt,now,this.thresholds.turnedSmilingMs),observedAt:smileAt},
      {type:'upper_body_slumped',label:'Có dấu hiệu gục đầu/thân trên',...this.slump.update(slumped,poseAt,now,this.thresholds.slumpMs),observedAt:poseAt},
    ];
    return {signals,calibration:{state:'ready',headingReady:true,postureReady:true,reference:'camera',
      startedAt:this.startedAt,expiresAt:this.startedAt}};
  }
}
