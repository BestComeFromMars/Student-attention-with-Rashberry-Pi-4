import type { StudentTrack, TrackedObject } from '../lib/types';
import {useRef} from 'react';
import { useElementSize,type ElementSize } from '../hooks/useElementSize';
import OverlayLabel,{overlayLabelLayout,stableOverlayLabel,createOverlayLayoutState,type OverlayLayoutState} from './OverlayLabel';

const NAMES={phone:'Điện thoại',book:'Sách/vở',laptop:'Laptop'};

/** Object IDs and rectangles belong to their own pixel trackers. An absent
 * face/hand owner affects the label, never whether the object box is drawn. */
export default function ObjectOverlay({objects,tracks,layoutState,size:provided}:{objects:TrackedObject[];tracks:StudentTrack[];layoutState?:OverlayLayoutState;size?:ElementSize}){
  const size=useElementSize<HTMLDivElement>(provided);
  const local=useRef(createOverlayLayoutState()),memory=layoutState??local.current;
  const alive=new Set(objects.map(object=>object.id));
  for(const id of Object.keys(memory.objects))if(!alive.has(id))delete memory.objects[id];
  const annotations=objects.map(object=>{
        const owner=tracks.find(track=>track.id===object.ownerId);
        const candidate=object.interaction===false;
        const confirmed=!candidate&&object.kind!=='book'&&owner?.signals?.some(signal=>signal.type===object.kind&&signal.state==='confirmed');
        const color=object.kind==='book'&&!candidate?'#2dd4bf':confirmed?'#ef4444':'#fbbf24';
        const box=object.displayBox??object.box;
        const x=box.x*size.width,y=box.y*size.height;
        const width=box.width*size.width,height=box.height*size.height;
        const label=`${object.id} · ${NAMES[object.kind]}`;
        const description=`${NAMES[object.kind]} · ${object.id}${owner?' · HS '+owner.id:''}${candidate?' · Chưa rõ tương tác':''}`;
        const layout=overlayLabelLayout(label,undefined,size.width);
        const placed=stableOverlayLabel(object.id,{x,y,width,height},layout,size.width,size.height,[],memory.objects,object.trackedAt,object.kind,'top-right');
        return {object,candidate,color,x,y,width,height,label,description,layout,placed,
          background:confirmed?'#7f1d1d':'#0f172a'};
  });
  return <div className="object-overlay" ref={size.ref} aria-label="Khung nhận diện đồ vật">
    {size.width>0&&<svg width={size.width} height={size.height} aria-hidden="true" style={{display:'block',overflow:'hidden'}}>
      {annotations.map(({object,candidate,color,x,y,width,height})=>{
        return <g key={object.id} data-object-id={object.id} data-object-kind={object.kind} data-owner-id={object.ownerId}
          data-tracking-state={object.trackingState} data-interaction={candidate?'unconfirmed':'confirmed'}>
          <rect className="object-frame" x={x} y={y} width={width} height={height} rx={0}
            data-target-x={x} data-target-y={y} data-target-width={width} data-target-height={height}
            fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke"/>
        </g>;
      })}
      {annotations.map(({object,placed,label,description,layout,background,color})=><g key={object.id} data-object-label={object.id}>
        <title>{description}</title><OverlayLabel x={placed.x} y={placed.y} heading={label} layout={layout} background={background} accent={color} anchor={`object:${object.id}`}/>
      </g>)}
    </svg>}
    <div className="sr-only" role="list" aria-label="Đồ vật đang được theo dõi">{objects.map(object=>
      <span role="listitem" key={object.id}>{NAMES[object.kind]} {object.id}{object.ownerId?', học sinh '+object.ownerId:''}</span>)}</div>
  </div>;
}
