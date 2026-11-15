import type {Box,StudentTrack,TrackedObject} from './types.js';
import {iou} from './geometry.js';

interface Sample {box:Box;at:number;}
const valid=(b:Box)=>[b.x,b.y,b.width,b.height].every(Number.isFinite)&&b.x>=0&&b.y>=0&&b.width>0&&b.height>0&&b.x+b.width<=1.000001&&b.y+b.height<=1.000001;
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));

/** Causal display filter only. Raw model boxes still drive identity and behavior. */
export class BoxPresentation {
  private samples=new Map<string,Sample>();
  private smooth(key:string,box:Box,at:number,alive:Set<string>):Box {
    alive.add(key);
    const previous=this.samples.get(key);
    if(!valid(box)){this.samples.delete(key);return {...box};}
    const dt=previous?at-previous.at:Infinity;
    const remember=(result:Box)=>{this.samples.set(key,{box:result,at});return {...result};};
    if(!previous||dt<0||dt>750||iou(previous.box,box)<.25||
      Math.max(box.width/previous.box.width,previous.box.width/box.width,box.height/previous.box.height,previous.box.height/box.height)>2)
      return remember({...box});
    if(dt===0)return {...previous.box};
    const before=previous.box,cx=box.x+box.width/2,cy=box.y+box.height/2;
    const px=before.x+before.width/2,py=before.y+before.height/2;
    const movement=Math.max(Math.abs(cx-px)/box.width,Math.abs(cy-py)/box.height);
    // Fast motion catches up immediately; small detector/scale corrections are damped.
    const position=1-Math.exp(-dt/(movement>.15?28:110));
    const scale=1-Math.exp(-dt/210);
    const width=clamp(before.width+(box.width-before.width)*scale,box.width*.88,box.width*1.12);
    const height=clamp(before.height+(box.height-before.height)*scale,box.height*.88,box.height*1.12);
    const x=Math.abs(cx-px)<=box.width*.01?px:px+(cx-px)*position;
    const y=Math.abs(cy-py)<=box.height*.01?py:py+(cy-py)*position;
    return remember({x:clamp(x-width/2,0,1-width),y:clamp(y-height/2,0,1-height),width,height});
  }
  update(tracks:StudentTrack[],objects:TrackedObject[],at:number){
    const alive=new Set<string>();
    const displayed=tracks.map(track=>{
      if(track.status!=='visible')return {...track,displayBoxes:undefined};
      const owner=track.personId??track.geometryId??track.id;
      const displayBoxes:NonNullable<StudentTrack['displayBoxes']>={};
      if(track.personBox)displayBoxes.person=this.smooth(`person:${track.id}:${owner}`,track.personBox,at,alive);
      if(track.faceVisibility!=='unavailable'&&track.trackingState!=='predicted'&&(track.faceBox||track.boxKind==='face'))
        displayBoxes.face=this.smooth(`face:${track.id}:${owner}:${track.geometryId??''}`,track.faceBox??track.box,at,alive);
      displayBoxes.box=track.boxKind==='person'?displayBoxes.person:track.boxKind==='face'?displayBoxes.face:undefined;
      return {...track,displayBoxes};
    });
    const displayedObjects=objects.map(object=>({...object,displayBox:this.smooth(`object:${object.id}:${object.kind}`,object.box,at,alive)}));
    // No smoothing through a missing face/person/object, or into another identity.
    for(const key of this.samples.keys())if(!alive.has(key))this.samples.delete(key);
    return {tracks:displayed,objects:displayedObjects};
  }
}
