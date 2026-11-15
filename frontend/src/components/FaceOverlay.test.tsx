import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { StudentTrack } from '../lib/types';
import FaceOverlay from './FaceOverlay';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('Motion SVG face annotations', () => {
  it('keeps the same solid rectangle during a bounded native miss and removes it on a rejected location',()=>{
    vi.spyOn(Element.prototype,'getBoundingClientRect').mockReturnValue({width:1000,height:500} as DOMRect);
    vi.stubGlobal('ResizeObserver',class { observe() {} disconnect() {} });
    const track:StudentTrack={id:'A',displayName:'A',boxKind:'face',color:'',lastSeen:1000,
      status:'visible',trackingState:'face',box:{x:.2,y:.2,width:.2,height:.3}};
    const {container,rerender}=render(<FaceOverlay tracks={[track]}/>);
    const rectangle=container.querySelector('.face-frame');
    rerender(<FaceOverlay tracks={[{...track,status:'lost',trackingState:'coasting'}]}/>);
    expect(container.querySelector('.face-frame')).toBe(rectangle);
    expect(rectangle?.getAttribute('width')).toBe('200');
    expect(container.textContent).toContain('Đang bám mặt');
    rerender(<FaceOverlay tracks={[{...track,status:'lost',trackingState:'predicted'}]}/>);
    expect(container.querySelector('.face-frame')).toBeNull();
  });
  it('does not draw an unsupported old ROI on the background beside a reacquired face',()=>{
    vi.spyOn(Element.prototype,'getBoundingClientRect').mockReturnValue({width:1000,height:500} as DOMRect);
    vi.stubGlobal('ResizeObserver',class { observe() {} disconnect() {} });
    const old:StudentTrack={id:'A',displayName:'A',boxKind:'face',color:'',lastSeen:0,
      status:'lost',trackingState:'predicted',box:{x:.08,y:.2,width:.26,height:.4},
      alerts:[{type:'phone',label:'Phone',observedAt:0,expiresAt:5000,held:true}]};
    const current:StudentTrack={...old,id:'B',displayName:'B',status:'visible',trackingState:'face',alerts:[],
      box:{x:.38,y:.2,width:.23,height:.4}};
    const {container}=render(<FaceOverlay tracks={[old,current]}/>);
    expect(container.querySelectorAll('.face-frame')).toHaveLength(1);
    expect(container.querySelector('[data-face-id="face-A"]')).toBeNull();
    expect(container.querySelector('[data-face-id="face-B"]')).not.toBeNull();
  });
  it('draws one continuous rectangle per face in video pixels, including an inferred face', () => {
    vi.spyOn(Element.prototype,'getBoundingClientRect').mockReturnValue({width:1000,height:500} as DOMRect);
    vi.stubGlobal('ResizeObserver',class { observe() {} disconnect() {} });
    const tracks: StudentTrack[] = ['focused','uncertain','needs_attention'].map((attention,index)=>({
      id:String.fromCharCode(65+index),displayName:'Học sinh',boxKind:'face',
      attention:attention as StudentTrack['attention'],color:'',lastSeen:0,status:'visible',
      box:{x:.1+index*.3,y:.2,width:.2,height:.3},
    }));
    const {container,rerender}=render(<FaceOverlay tracks={tracks}/>);
    const frames=container.querySelectorAll('.face-frame');
    expect(frames).toHaveLength(3);
    expect(frames[0].getAttribute('x')).toBe('100');
    expect(frames[0].getAttribute('width')).toBe('200');
    expect(frames[0].getAttribute('height')).toBe('150');
    expect([...frames].map(node=>node.getAttribute('stroke'))).toEqual(['#22c55e','#22c55e','#ef4444']);
    expect(container.querySelectorAll('line,polyline,canvas')).toHaveLength(0);
    rerender(<FaceOverlay tracks={[{...tracks[0],status:'lost',trackingState:'body'}]}/>);
    expect(container.querySelector('.face-frame')?.getAttribute('stroke-dasharray')).toBeNull();
    expect(container.textContent).toContain('Bám theo người');
  });
  it('does not draw a body rectangle as a face', () => {
    vi.spyOn(Element.prototype,'getBoundingClientRect').mockReturnValue({width:1000,height:500} as DOMRect);
    vi.stubGlobal('ResizeObserver',class { observe() {} disconnect() {} });
    const {container}=render(<FaceOverlay tracks={[{id:'A',displayName:'A',color:'',lastSeen:0,status:'visible',box:{x:0,y:0,width:.2,height:.9}}]}/>);
    expect(container.querySelectorAll('.face-frame')).toHaveLength(0);
  });
});
