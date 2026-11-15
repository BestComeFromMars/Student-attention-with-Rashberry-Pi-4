import {act,cleanup,render} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import AnimatedOverlays from './AnimatedOverlays';
import {createOverlayLayoutState} from './OverlayLabel';
import type {StudentTrack} from '../lib/types';

afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('one viewport for face and body publication',()=>{
  it('mounts and resizes both rectangles together and keeps a single body label',()=>{
    let width=0,height=0;
    const notify:(()=>void)[]=[];
    vi.stubGlobal('ResizeObserver',class{
      constructor(callback:()=>void){notify.push(callback);}
      observe(){}disconnect(){}
    });
    vi.spyOn(Element.prototype,'getBoundingClientRect').mockImplementation(()=>({width,height}) as DOMRect);
    const body={x:.1,y:.1,width:.3,height:.7};
    const track:StudentTrack={id:'A',displayName:'A',color:'',status:'visible',lastSeen:1000,boxKind:'person',
      box:body,personBox:body,faceVisibility:'visible',faceBox:{x:.2,y:.12,width:.1,height:.15}};
    const layoutState=createOverlayLayoutState();
    const {container,rerender}=render(<AnimatedOverlays tracks={[track]} objects={[]} layoutState={layoutState}/>);
    expect(container.querySelectorAll('.person-frame,.face-frame')).toHaveLength(0);
    expect(notify).toHaveLength(1);
    act(()=>{width=1000;height=600;notify[0]();});
    expect(container.querySelector('.person-frame')?.getAttribute('width')).toBe('300');
    expect(container.querySelector('.face-frame')?.getAttribute('width')).toBe('100');
    expect(container.querySelectorAll('.observation-label')).toHaveLength(1);
    const label=container.querySelector('.observation-label')!;
    expect(Number(label.getAttribute('x'))+Number(label.getAttribute('width'))).toBe(400);
    act(()=>{width=500;height=300;notify[0]();});
    expect(container.querySelector('.person-frame')?.getAttribute('width')).toBe('150');
    expect(container.querySelector('.face-frame')?.getAttribute('width')).toBe('50');
    rerender(<AnimatedOverlays tracks={[{...track,lastSeen:1700,faceVisibility:'unavailable'}]} objects={[]} layoutState={layoutState}/>);
    expect(container.querySelectorAll('.person-frame')).toHaveLength(1);
    expect(container.querySelectorAll('.face-frame')).toHaveLength(0);
  });
});
