import {render} from '@testing-library/react';
import {describe,it,expect,vi} from 'vitest';
import PersonOverlay from './PersonOverlay';
import FaceOverlay from './FaceOverlay';
import type {StudentTrack} from '../lib/types';
vi.mock('../hooks/useElementSize',()=>({useElementSize:()=>({ref:()=>{},width:1000,height:600})}));
describe('separate person and face rectangles',()=>{
  it('renders distinct person and face coordinates for the same ID',()=>{
    vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
    vi.spyOn(Element.prototype,'getBoundingClientRect').mockReturnValue({width:1000,height:600} as DOMRect);
    const track:StudentTrack={id:'A',displayName:'A',color:'',status:'visible',lastSeen:0,boxKind:'person',
      box:{x:.1,y:.1,width:.3,height:.7},personBox:{x:.1,y:.1,width:.3,height:.7},faceVisibility:'visible',
      faceBox:{x:.2,y:.12,width:.1,height:.15},calibration:{state:'collecting',headingReady:false,postureReady:false,startedAt:0,expiresAt:20000}};
    const {container}=render(<><PersonOverlay tracks={[track]}/><FaceOverlay tracks={[track]}/></>);
    expect(container.querySelector('[data-person-id="A"] .person-frame')!.getAttribute('width')).toBe('300');
    expect(container.querySelector('[data-face-id="face-A"] .face-frame')!.getAttribute('width')).toBe('100');
    expect(container.textContent).toContain('Đang lấy hướng chuẩn');
  });
  it.each(['head_turned','torso_turned','turned_smiling','upper_body_slumped'] as const)('shows %s on the body without drawing an unavailable face',type=>{
    vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
    const track:StudentTrack={id:'A',displayName:'A',color:'',status:'visible',lastSeen:0,boxKind:'person',
      box:{x:.1,y:.1,width:.3,height:.7},personBox:{x:.1,y:.1,width:.3,height:.7},faceVisibility:'unavailable',
      faceBox:{x:.2,y:.1,width:.1,height:.1},attention:'needs_attention',
      alerts:[{type,label:'Cảnh báo tư thế',observedAt:1000,expiresAt:6000,held:true}]};
    const {container}=render(<><PersonOverlay tracks={[track]}/><FaceOverlay tracks={[track]}/></>);
    expect(container.querySelectorAll('.person-frame')).toHaveLength(1);
    expect(container.querySelectorAll('.face-frame')).toHaveLength(0);
    expect(container.textContent).toContain('Vừa ghi nhận: Cảnh báo tư thế');
  });
  it('shows a head-turn warning on the body when the face is unavailable',()=>{
    const track:StudentTrack={id:'A',displayName:'A',color:'',status:'visible',lastSeen:0,boxKind:'person',
      box:{x:.1,y:.1,width:.3,height:.7},personBox:{x:.1,y:.1,width:.3,height:.7},faceVisibility:'unavailable',
      attention:'needs_attention',alerts:[{type:'head_turning',label:'Quay đầu qua lại nhiều lần',observedAt:1000,expiresAt:6000,held:false}]};
    const {container}=render(<PersonOverlay tracks={[track]}/>);
    expect(container.textContent).toContain('Quay đầu qua lại nhiều lần');
    expect(container.textContent).toContain('Chưa thấy mặt');
    expect(container.querySelector('.person-frame')!.getAttribute('stroke')).toBe('#ef4444');
  });
  it('shows body and activity while hiding the unavailable face',()=>{
    vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
    const track:StudentTrack={id:'A',displayName:'A',color:'',status:'visible',lastSeen:0,boxKind:'person',
      box:{x:.1,y:.1,width:.3,height:.7},personBox:{x:.1,y:.1,width:.3,height:.7},faceVisibility:'unavailable',
      actions:[{type:'read',label:'Đang đọc',state:'confirmed',source:'MobileViCLIP-Tiny',observedAt:0}]};
    const {container}=render(<><PersonOverlay tracks={[track]}/><FaceOverlay tracks={[track]}/></>);
    expect(container.querySelectorAll('.person-frame')).toHaveLength(1);
    expect(container.querySelectorAll('.face-frame')).toHaveLength(0);expect(container.textContent).toContain('Đang đọc');
  });
});
