import {describe,it,expect} from 'vitest';
import {stableOverlayLabel,personLabelPlacements,placeOverlayLabel,type LabelMemory} from './OverlayLabel';
import type {StudentTrack} from '../lib/types';
const box={x:200,y:200,width:100,height:200},layout={width:200,height:32};
describe('stable annotation positions',()=>{
  it('anchors the person label to the body top right even when its face moves or becomes unavailable',()=>{
    const memory:LabelMemory={};const body={x:.2,y:.2,width:.3,height:.5};
    const track:StudentTrack={id:'A',displayName:'A',color:'',status:'visible',lastSeen:1000,boxKind:'person',
      box:body,personBox:body,faceVisibility:'visible',faceBox:{x:.22,y:.25,width:.08,height:.1}};
    const before=personLabelPlacements([track],1000,600,memory).get('A')!;
    expect(before.rect.x+before.rect.width).toBe(500);
    expect(before.rect.y+before.rect.height).toBe(120);
    const moved=personLabelPlacements([{...track,lastSeen:1700,faceBox:{...track.faceBox!,x:.38}}],1000,600,memory).get('A')!;
    const hidden=personLabelPlacements([{...track,lastSeen:2400,faceVisibility:'unavailable'}],1000,600,memory).get('A')!;
    expect(moved.rect).toEqual(before.rect);expect(hidden.rect).toEqual(before.rect);
  });
  it('keeps the requested corner through label collisions and keeps edge labels inside the viewport',()=>{
    const memory:LabelMemory={};const badge={width:110,height:25};
    const placed=stableOverlayLabel('A',box,badge,1000,600,[{x:0,y:0,width:1000,height:600}],memory,1000,'7','top-right');
    expect(placed).toEqual({x:190,y:175,...badge});
    expect(placeOverlayLabel({x:1,y:1,width:20,height:20},badge,1000,600,[],'top-right')).toEqual({x:0,y:1,...badge});
    expect(placeOverlayLabel({x:990,y:100,width:20,height:50},badge,1000,600,[],'top-right').x).toBe(890);
  });
  it('uses compact camera badges and prioritizes a slump over other held warnings',()=>{
    const body={x:.2,y:.2,width:.2,height:.5};
    const track:StudentTrack={id:'A',displayName:'Học sinh A',color:'',status:'visible',lastSeen:1000,boxKind:'person',
      box:body,personBox:body,faceVisibility:'unavailable'};
    const regular=personLabelPlacements([track],1000,600).get('A')!;
    expect(regular.heading).toBe('A');expect(regular.layout.height).toBe(25);expect(regular.layout.width).toBeLessThan(40);
    track.alerts=[{type:'eyes_closed',label:'Nhắm mắt kéo dài',held:false,observedAt:1000,expiresAt:6000},
      {type:'upper_body_slumped',label:'Có dấu hiệu gục đầu/thân trên',held:true,observedAt:900,expiresAt:5900}];
    const warning=personLabelPlacements([track],1000,600).get('A')!;
    expect(warning.heading).toBe('A · Gục người');expect(warning.layout.lines).toEqual([]);
    expect(warning.description).toContain('Vừa ghi nhận: Có dấu hiệu gục đầu/thân trên');
  });
  it('keeps an existing slot through small edge collisions instead of jumping between candidates',()=>{
    const memory:LabelMemory={};const first=stableOverlayLabel('A',box,layout,1000,600,[],memory,1000,'7');
    const edge={x:first.x+first.width-1,y:first.y,width:100,height:32};
    const next=stableOverlayLabel('A',box,layout,1000,600,[edge],memory,1033,'7');
    expect(next).toEqual(first);
  });
  it('moves away promptly when a large new obstruction covers the label',()=>{
    const memory:LabelMemory={};const first=stableOverlayLabel('A',box,layout,1000,600,[],memory,1000,'7');
    expect(stableOverlayLabel('A',box,layout,1000,600,[first],memory,1033,'7')).not.toEqual(first);
  });
  it('preserves the next result across an export browser restart using serializable state',()=>{
    const memory:LabelMemory={};stableOverlayLabel('A',box,layout,1000,600,[],memory,1000,'7');
    const restored=JSON.parse(JSON.stringify(memory));const moved={...box,x:202};
    expect(stableOverlayLabel('A',moved,layout,1000,600,[],restored,1033,'7'))
      .toEqual(stableOverlayLabel('A',moved,layout,1000,600,[],memory,1033,'7'));
  });
  it('discards stale slots on identity changes, canvas resize and disappearance',()=>{
    const memory:LabelMemory={};stableOverlayLabel('A',box,layout,1000,600,[],memory,1000,'7');
    const changed=stableOverlayLabel('A',{...box,x:700},layout,800,600,[],memory,1033,'8');
    expect(changed.x+changed.width).toBeLessThanOrEqual(800);
    expect(memory.A.scope).toContain('8');
    const track:StudentTrack={id:'A',displayName:'A',color:'',lastSeen:1100,status:'visible',personId:8,
      boxKind:'person',box:{x:.2,y:.2,width:.2,height:.5},personBox:{x:.2,y:.2,width:.2,height:.5}};
    personLabelPlacements([track],800,600,memory);expect(memory.A).toBeDefined();
    personLabelPlacements([],800,600,memory);expect(memory).toEqual({});
  });
});
