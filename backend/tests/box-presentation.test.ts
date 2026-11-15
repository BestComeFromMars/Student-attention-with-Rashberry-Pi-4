import {describe,it,expect} from 'vitest';
import {BoxPresentation} from '../src/box-presentation.js';
import {Sessions} from '../src/sessions.js';
import type {Box,StudentTrack,TrackedObject,InferenceEngine} from '../src/types.js';

const box:Box={x:.2,y:.2,width:.2,height:.4};
const track=(at:number,b=box,personId=7):StudentTrack=>({id:'A',displayName:'A',color:'',lastSeen:at,status:'visible',
  personId,geometryId:9,boxKind:'person',box:{...b},personBox:{...b},faceBox:{x:.25,y:.22,width:.08,height:.1},faceVisibility:'visible'});
const object=(at:number,b=box):TrackedObject=>({id:'O1',kind:'book',box:{...b},confidence:.8,observedAt:at,trackedAt:at,trackingState:'visual'});
describe('causal presentation boxes',()=>{
  it('damps repeated scale jitter while leaving raw rectangles and observations untouched',()=>{
    const filter=new BoxPresentation();const raw:number[]=[],shown:number[]=[];
    for(let n=0;n<60;n++){
      const width=n%2?.22:.2,input=track(n*33,{...box,x:.3-width/2,width});
      const before=JSON.stringify(input),result=filter.update([input],[object(n*33,input.box)],n*33);
      expect(JSON.stringify(input)).toBe(before);expect(result.tracks[0].personBox).toEqual(input.personBox);
      raw.push(width);shown.push(result.tracks[0].displayBoxes!.person!.width);
      expect(result.objects[0].displayBox!.width).toBeCloseTo(shown.at(-1)!,8);
    }
    const variation=(values:number[])=>values.slice(1).reduce((sum,value,i)=>sum+Math.abs(value-values[i]),0);
    expect(variation(shown)).toBeLessThan(variation(raw)*.3);
  });
  it('catches fast real translation, snaps a large relocation and bounds size lag',()=>{
    const filter=new BoxPresentation();filter.update([track(1000)],[],1000);
    const moved={...box,x:.25,width:.25};
    const shown=filter.update([track(1033,moved)],[],1033).tracks[0].displayBoxes!.person!;
    expect(Math.abs(shown.x+shown.width/2-(moved.x+moved.width/2))).toBeLessThan(.025);
    expect(shown.width).toBeGreaterThanOrEqual(moved.width*.88);
    const far={...box,x:.75};expect(filter.update([track(1066,far)],[],1066).tracks[0].displayBoxes!.person).toEqual(far);
  });
  it('never retains a missing face, object, person, or smoothing history across a new identity',()=>{
    const filter=new BoxPresentation();filter.update([track(1000)],[object(1000)],1000);
    const hidden={...track(1033),faceVisibility:'unavailable' as const};delete hidden.faceBox;
    const result=filter.update([hidden],[],1033);expect(result.tracks[0].displayBoxes!.face).toBeUndefined();expect(result.objects).toEqual([]);
    const returned=track(1066);returned.faceBox={x:.26,y:.23,width:.1,height:.12};
    expect(filter.update([returned],[],1066).tracks[0].displayBoxes!.face).toEqual(returned.faceBox);
    const replacement=track(1100,{...box,width:.22},8);
    expect(filter.update([replacement],[],1100).tracks[0].displayBoxes!.person).toEqual(replacement.personBox);
    filter.update([],[],1133);
    expect(filter.update([track(1166)],[],1166).tracks[0].displayBoxes!.person).toEqual(box);
  });
  it('does not advance on duplicate timestamps and resets after a gap or source-clock rewind',()=>{
    const filter=new BoxPresentation();filter.update([track(1000)],[],1000);
    const resized=track(1000,{...box,width:.22});
    expect(filter.update([resized],[],1000).tracks[0].displayBoxes!.person).toEqual(box);
    expect(filter.update([resized],[],2000).tracks[0].displayBoxes!.person).toEqual(resized.personBox);
    expect(filter.update([track(500)],[],500).tracks[0].displayBoxes!.person).toEqual(box);
  });
  it('keeps independent histories for object classes and face reacquisitions',()=>{
    const filter=new BoxPresentation();filter.update([track(1000)],[object(1000)],1000);
    const face=track(1033);face.geometryId=10;face.faceBox={x:.26,y:.22,width:.1,height:.11};
    const changed={...object(1033,{...box,width:.22}),kind:'phone' as const};
    const result=filter.update([face],[changed],1033);
    expect(result.tracks[0].displayBoxes!.face).toEqual(face.faceBox);expect(result.objects[0].displayBox).toEqual(changed.box);
  });
  it('resets display history when the session changes its camera source',async()=>{
    let now=1000,b=box;const sessions=new Sessions(()=>now),id=sessions.create();
    const engine:InferenceEngine={ready:true,close:async()=>{},release:()=>{},detect:async()=>[track(now,b)]};
    await sessions.detect(id,Buffer.from('x'),engine);now=1033;b={...box,width:.22};
    const continuous=(await sessions.detect(id,Buffer.from('x'),engine))[0];
    expect(continuous.displayBoxes!.person!.width).toBeLessThan(b.width);
    now=1066;expect((await sessions.detect(id,Buffer.from('x'),engine,'pi'))[0].displayBoxes!.person).toEqual(b);
  });
});
