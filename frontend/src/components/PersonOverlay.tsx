import type {StudentTrack} from '../lib/types';
import {useRef} from 'react';
import {useElementSize,type ElementSize} from '../hooks/useElementSize';
import OverlayLabel,{personLabelPlacements,createOverlayLayoutState,type OverlayLayoutState} from './OverlayLabel';

/** A body rectangle never substitutes for a face rectangle. */
export default function PersonOverlay({tracks,layoutState,size:provided}:{tracks:StudentTrack[];layoutState?:OverlayLayoutState;size?:ElementSize}){
  const size=useElementSize<HTMLDivElement>(provided);
  const local=useRef(createOverlayLayoutState());
  const labels=personLabelPlacements(tracks,size.width,size.height,(layoutState??local.current).people);
  return <div className="person-overlay" ref={size.ref} aria-label="Khung theo dõi người và hành động">
    {size.width>0&&<><svg width={size.width} height={size.height} style={{position:'absolute',inset:0,zIndex:2,display:'block',overflow:'hidden'}} aria-hidden="true">
      {tracks.filter(t=>t.personBox&&t.status==='visible').sort((a,b)=>Number(Boolean(a.alerts?.length))-Number(Boolean(b.alerts?.length))).map(track=>{
        const box=track.displayBoxes?.person??track.personBox!,x=box.x*size.width,y=box.y*size.height,w=box.width*size.width,h=box.height*size.height;
        const label=labels.get(track.id)!;
        return <g key={track.id} data-person-id={track.id}>
          <rect className="person-frame" x={x} y={y} width={w} height={h} data-target-x={x} data-target-y={y} data-target-width={w} data-target-height={h}
            rx={0} fill="none" stroke={label.color} strokeWidth={label.warning?2:1.5} vectorEffect="non-scaling-stroke"/>
        </g>;
      })}
    </svg>
    <svg width={size.width} height={size.height} style={{position:'absolute',inset:0,zIndex:4,display:'block',overflow:'hidden'}} aria-hidden="true">
      {[...labels.entries()].sort((a,b)=>Number(a[1].warning)-Number(b[1].warning)).map(([id,label])=>
        <g key={id} data-person-label={id}><title>{label.description}</title><OverlayLabel x={label.rect.x} y={label.rect.y} heading={label.heading}
          layout={label.layout} background={label.background} accent={label.color} anchor={`person:${id}`}/></g>)}
    </svg></>}
    <span className="sr-only">{tracks.filter(t=>t.personBox&&t.faceVisibility==='unavailable').map(t=>`${t.id}: Chưa thấy mặt`).join('; ')}</span>
  </div>;
}
