import {useLayoutEffect,useRef} from 'react';
import type {ObservationSession} from '../lib/session';
import {overlayCaption} from '../lib/overlay-caption';

const OBJECT_LABELS={phone:'Điện thoại',book:'Sách/vở',laptop:'Laptop'};

export default function PlaybackOverlay({session,width,height}:{session:ObservationSession;width:number;height:number}){
  const ref=useRef<HTMLCanvasElement>(null);
  useLayoutEffect(()=>session.attachPlaybackOverlay(({keys,boxes,tracks,objects})=>{
    const canvas=ref.current,context=canvas?.getContext('2d');
    if(!context||!canvas)return;
    context.clearRect(0,0,width,height);
    context.font='600 15px system-ui';
    context.textBaseline='middle';
    const people=new Map(tracks.map(track=>[track.id,track]));
    const items=new Map(objects.map(object=>[object.id,object]));
    const bodies=new Set<string>();
    for(let i=0;i<boxes.length;i+=5){
      const key=keys[boxes[i]];
      if(key?.startsWith('person:'))bodies.add(key.slice(7));
    }
    const labels:{text:string;x:number;y:number;color:string;warning:boolean}[]=[];
    for(let i=0;i<boxes.length;i+=5){
      const key=keys[boxes[i]];
      if(!key)continue;
      const separator=key.indexOf(':');
      const kind=key.slice(0,separator),id=key.slice(separator+1);
      const x=boxes[i+1]*width/10000,y=boxes[i+2]*height/10000;
      const w=boxes[i+3]*width/10000,h=boxes[i+4]*height/10000;
      const track=people.get(id);
      let text:string,color:string,warning:boolean;
      if(kind==='object'){
        const item=items.get(id);
        if(!item)continue;
        const owner=item.ownerId&&people.get(item.ownerId);
        warning=item.interaction!==false&&Boolean(owner&&owner.signals?.some(signal=>signal.type===item.kind&&signal.state==='confirmed'));
        text=id+' · '+OBJECT_LABELS[item.kind];
        color=warning?'#ef4444':item.kind==='book'&&item.interaction!==false?'#2dd4bf':'#fbbf24';
      }else{
        if(!track)continue;
        const caption=overlayCaption(track);
        text=caption.heading;warning=caption.warning;
        color=warning?caption.color:kind==='face'?'#22c55e':caption.color;
      }
      context.strokeStyle=color;context.lineWidth=warning||kind==='face'?2:1.5;
      context.strokeRect(x,y,w,h);
      if(kind!=='face'||!bodies.has(id))labels.push({text,x:x+w,y,color,warning});
    }
    for(const label of labels.sort((a,b)=>Number(a.warning)-Number(b.warning))){
      const w=Math.min(width,context.measureText(label.text).width+14);
      const x=Math.max(0,Math.min(width-w,label.x-w));
      const y=Math.max(0,Math.min(height-24,label.y>=24?label.y-24:label.y));
      context.fillStyle=label.warning?'#7f1d1d':'#0f172a';
      context.fillRect(x,y,w,24);
      context.strokeStyle=label.color;context.lineWidth=1;context.strokeRect(x+.5,y+.5,w-1,23);
      context.fillStyle='#f8fafc';context.fillText(label.text,x+7,y+12,w-14);
    }
  }),[session,width,height]);
  return <canvas ref={ref} width={width} height={height} className="playback-overlay" aria-hidden="true"/>;
}
