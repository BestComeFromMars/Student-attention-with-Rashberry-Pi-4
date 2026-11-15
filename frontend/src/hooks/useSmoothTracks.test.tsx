import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSmoothTracks } from './useSmoothTracks';
import type { StudentTrack } from '../lib/types';

const face = (width=.15): StudentTrack => ({id:'A',displayName:'A',boxKind:'face',color:'',
  lastSeen:0,status:'visible',box:{x:.3,y:.2,width,height:.2}});
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>setTimeout(()=>callback(performance.now()),16));
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>clearTimeout(id));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('face presentation lifecycle', () => {
  it('renders backend coordinates exactly and never retains a missing face over a newer image', () => {
    const {result,rerender} = renderHook(({tracks,running,scope})=>useSmoothTracks(tracks,running,scope),
      {initialProps:{tracks:[face()],running:true,scope:'session-1'}});
    expect(result.current).toHaveLength(1);
    rerender({tracks:[],running:true,scope:'session-1'});
    expect(result.current).toEqual([]);
    rerender({tracks:[],running:true,scope:'session-2'});
    expect(result.current).toEqual([]);
    rerender({tracks:[face(.3)],running:true,scope:'session-2'});
    expect(result.current[0].box.width).toBeCloseTo(.3,8);
    rerender({tracks:[face(.3)],running:false,scope:'session-2'});
    expect(result.current).toEqual([]);
    act(()=>vi.advanceTimersByTime(1000));
    expect(result.current).toEqual([]);
  });
});
