import {describe,it,expect} from 'vitest';
import {currentGeometry} from './current-geometry';
import type {StudentTrack,TrackedObject} from './types';

const old={x:.1,y:.1,width:.2,height:.3},now={x:.5,y:.2,width:.2,height:.3};
const person={id:'A',displayName:'A',status:'visible',box:old,personBox:old,faceBox:old,
  faceVisibility:'visible',boxKind:'person',displayBoxes:{person:old,face:old},color:'red',lastSeen:0,
  alerts:[{type:'upper_body_slumped',label:'Gục người',held:false,observedAt:0,expiresAt:5000}]} as StudentTrack;
describe('current-image geometry with delayed semantics',()=>{
  it('does not resurrect a retired duplicate identity from an old pixel tracker',()=>{
    const result=currentGeometry([{...person,status:'lost',trackingState:'predicted'}],[],{
      frameId:90,processingMs:5,boxes:[{key:'person:A',box:now}]});
    expect(result.tracks).toEqual([]);
  });
  it('changes geometry without waiting for the next AI label/color',()=>{
    const result=currentGeometry([person],[],{frameId:70,processingMs:5,boxes:[
      {key:'person:A',box:now},{key:'face:A',box:{...now,width:.05,height:.05}}]});
    expect(result.tracks[0].personBox).toEqual(now);
    expect(result.tracks[0].faceBox?.x).toBe(.5);
    expect(result.tracks[0].displayBoxes).toBeUndefined();
    expect(result.tracks[0].alerts).toEqual(person.alerts);
  });
  it('never displays an old face/body box without current-pixel support',()=>{
    const result=currentGeometry([person],[],{frameId:71,processingMs:5,boxes:[{key:'person:A',box:now}]});
    expect(result.tracks[0].faceBox).toBeUndefined();expect(result.tracks[0].faceVisibility).toBe('unavailable');
    expect(currentGeometry([person],[],{frameId:72,processingMs:5,boxes:[]}).tracks).toEqual([]);
  });
  it('uses current coordinates for objects independently from people',()=>{
    const object={id:'O1',kind:'book',box:old,displayBox:old,confidence:.8,observedAt:0,trackedAt:0,trackingState:'visual'} as TrackedObject;
    const result=currentGeometry([person],[object],{frameId:73,processingMs:5,boxes:[{key:'object:O1',box:now}]});
    expect(result.tracks).toEqual([]);expect(result.objects[0].box).toEqual(now);expect(result.objects[0].displayBox).toBeUndefined();
  });
});
