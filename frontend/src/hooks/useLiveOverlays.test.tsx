import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {useLiveOverlays} from './useLiveOverlays';
import type {StudentTrack,TrackedObject} from '../lib/types';

const tracks:StudentTrack[]=[{id:'A',displayName:'A',color:'',status:'visible',lastSeen:0,box:{x:.1,y:.1,width:.2,height:.3}}];
const objects:TrackedObject[]=[{id:'book',kind:'book',box:tracks[0].box,confidence:.9,observedAt:0,trackedAt:0,trackingState:'detected'}];
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{cleanup();vi.useRealTimers();});
describe('live camera overlays',()=>{
  it('holds boxes unchanged for any inference delay and replaces them only on the next decision',()=>{
    const {result,rerender}=renderHook(({people,items,running})=>useLiveOverlays(people,items,running),
      {initialProps:{people:tracks,items:objects,running:true}});
    act(()=>vi.advanceTimersByTime(30000));
    expect(result.current.tracks).toBe(tracks);
    expect(result.current.objects).toBe(objects);
    const next=[{...tracks[0],box:{...tracks[0].box,x:.6}}];
    rerender({people:next,items:[],running:true});
    expect(result.current.tracks[0].box.x).toBe(.6);
    rerender({people:next,items:[],running:false});
    expect(result.current.tracks).toEqual([]);
  });
  it('clears a previous decision when AI returns an empty scene',()=>{
    const {result,rerender}=renderHook(({people,items})=>useLiveOverlays(people,items,true),
      {initialProps:{people:tracks,items:objects}});
    rerender({people:[],items:[]});
    expect(result.current).toEqual({tracks:[],objects:[]});
  });
});
