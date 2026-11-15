import type {StudentTrack} from '../lib/types';
import {overlayCaption} from '../lib/overlay-caption';
import {topRightLabel,type OverlayRect} from '../lib/overlay-anchor';

const FONT=13,ROW=19,PADDING=8;
export type LabelRect=OverlayRect;
interface LabelMemoryEntry {box:LabelRect;rect:LabelRect;at:number;scope:string;blockedSince?:number;}
export type LabelMemory=Record<string,LabelMemoryEntry>;
export interface OverlayLayoutState {people:LabelMemory;objects:LabelMemory;}
type LabelPlacement='free'|'above'|'top-right';
export const createOverlayLayoutState=():OverlayLayoutState=>({people:{},objects:{}});

const overlap=(a:LabelRect,b:LabelRect)=>Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*
  Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));

export function protectedHeads(tracks:StudentTrack[],width:number,height:number):LabelRect[]{
  return tracks.filter(t=>t.status==='visible').flatMap(track=>{
    const face=track.faceVisibility!=='unavailable'?(track.displayBoxes?.face??track.faceBox??(track.boxKind==='face'?track.box:undefined)):undefined;
    if(face){
      const x=face.x*width,y=face.y*height,w=face.width*width,h=face.height*height;
      return [{x:x-4,y:y-4,width:w+8,height:h+8},...(!track.personBox?[{x,y:Math.max(0,y-34),width:40,height:32}]:[])];
    }
    const body=track.displayBoxes?.person??track.personBox;
    return body?[{x:body.x*width,y:body.y*height,width:body.width*width,height:body.height*height*.4}]:[];
  });
}

/** Keep large labels away from observed heads and previously placed labels. */
export function placeOverlayLabel(box:LabelRect,layout:{width:number;height:number},width:number,height:number,blocked:LabelRect[],placement:LabelPlacement='free'){
  if(placement==='top-right')return topRightLabel(box,layout,{width,height});
  const above=placement==='above';
  const preferred=above?{x:box.x+box.width/2-layout.width/2,y:box.y-layout.height-8}:{x:box.x,y:box.y+box.height-layout.height};
  const candidates=above?[]:[preferred,{x:box.x,y:box.y+box.height+6},{x:box.x,y:box.y-layout.height-6},
    {x:box.x+box.width+6,y:box.y},{x:box.x-layout.width-6,y:box.y}];
  if(above){
    const shift=Math.min(80,layout.width*.6);
    for(const lift of [0,30,60,90])for(const offset of [0,-shift,shift,-shift*2,shift*2])
      candidates.push({x:preferred.x+offset,y:preferred.y-lift});
  }else for(let step=1;step<=10;step++)for(const direction of [-1,1])for(const shift of [0,-layout.width/2,layout.width/2])
    candidates.push({x:preferred.x+shift,y:preferred.y+direction*step*32});
  let best={...preferred,...layout},bestScore=Infinity;
  for(const candidate of candidates){
    const rect={x:Math.max(0,Math.min(candidate.x,width-layout.width)),
      y:Math.max(0,Math.min(candidate.y,height-layout.height)),...layout};
    const allowance=above?layout.width*layout.height*.02:0;
    const score=blocked.reduce((sum,obstacle)=>sum+Math.max(0,overlap(rect,obstacle)-allowance)*20,0)+
      ((rect.x-preferred.x)**2+(rect.y-preferred.y)**2)*.005;
    if(score<bestScore){best=rect;bestScore=score;}
  }
  return best;
}

export function stableOverlayLabel(id:string,box:LabelRect,layout:{width:number;height:number},width:number,height:number,
  blocked:LabelRect[],memory:LabelMemory,at:number,identity:string,placement:LabelPlacement='free'){
  const scope=`${placement}:${width}x${height}:${identity}`,old=memory[id],above=placement==='above';
  if(placement==='top-right'){
    const rect=placeOverlayLabel(box,layout,width,height,blocked,placement);
    memory[id]={box:{...box},rect,at,scope};return rect;
  }
  let blockedSince:number|undefined;
  if(old&&old.scope===scope&&at>=old.at&&at-old.at<=1000&&
    overlap(box,old.box)/Math.max(1,box.width*box.height+old.box.width*old.box.height-overlap(box,old.box))>=.25){
    const candidate={x:Math.max(0,Math.min(width-layout.width,old.rect.x+box.x-old.box.x+(above?(box.width-old.box.width-layout.width+old.rect.width)/2:0))),
      y:Math.max(above?Math.max(0,box.y-layout.height-8-90):0,Math.min(above?Math.max(0,box.y-layout.height-8):height-layout.height,
        old.rect.y+box.y-old.box.y-(above?layout.height-old.rect.height:0))),...layout};
    const obstruction=blocked.reduce((sum,rect)=>sum+overlap(candidate,rect),0)/Math.max(1,layout.width*layout.height);
    blockedSince=obstruction>.04?old.blockedSince??at:undefined;
    // A tiny collision must persist before moving an otherwise stable label.
    if(obstruction<=.04||obstruction<.2&&at-(blockedSince??at)<350){
      memory[id]={box:{...box},rect:candidate,at,scope,blockedSince};return candidate;
    }
  }
  const rect=placeOverlayLabel(box,layout,width,height,blocked,placement);
  memory[id]={box:{...box},rect,at,scope};return rect;
}

export function personLabelPlacements(tracks:StudentTrack[],width:number,height:number,memory?:LabelMemory){
  const result=new Map<string,{heading:string;description:string;color:string;background:string;layout:ReturnType<typeof overlayLabelLayout>;rect:LabelRect;warning:boolean}>();
  const people=tracks.filter(t=>t.personBox&&t.status==='visible').sort((a,b)=>
    Number(Boolean(b.alerts?.length)||b.attention==='needs_attention')-Number(Boolean(a.alerts?.length)||a.attention==='needs_attention'));
  for(const track of people){
    const caption=overlayCaption(track),{heading,warning}=caption;
    const layout=overlayLabelLayout(heading,undefined,width),box=track.displayBoxes?.person??track.personBox!;
    const pixelBox={x:box.x*width,y:box.y*height,width:box.width*width,height:box.height*height};
    const identity=`${track.personId??track.geometryId??track.id}:person:${warning}`;
    const rect=memory?stableOverlayLabel(track.id,pixelBox,layout,width,height,[],memory,track.lastSeen,identity,'top-right'):
      placeOverlayLabel(pixelBox,layout,width,height,[],'top-right');
    result.set(track.id,{...caption,layout,rect});
  }
  if(memory)for(const id of Object.keys(memory))if(!result.has(id))delete memory[id];
  return result;
}

export function LabelLeader({box,label,color}:{box:LabelRect;label:LabelRect;color:string}){
  const cx=box.x+box.width/2,cy=box.y+box.height/2;
  const toX=Math.max(label.x,Math.min(cx,label.x+label.width)),toY=Math.max(label.y,Math.min(cy,label.y+label.height));
  const fromX=Math.max(box.x,Math.min(toX,box.x+box.width)),fromY=Math.max(box.y,Math.min(toY,box.y+box.height));
  return Math.hypot(toX-fromX,toY-fromY)>8?<line x1={fromX} y1={fromY} x2={toX} y2={toY}
    data-target-x1={fromX} data-target-y1={fromY} data-target-x2={toX} data-target-y2={toY} stroke={color} strokeWidth={1} opacity={.65}/>:null;
}

/** Wrap full behavior names instead of clipping them inside a small face box. */
export function overlayLabelLayout(heading:string,detail:string|undefined,availableWidth:number){
  const limit=Math.max(1,Math.floor((Math.min(300,availableWidth)-PADDING*2)/(FONT*.62)));
  const lines:string[]=[];
  for(const word of detail?.split(/\s+/)??[]){
    if(!lines.length||lines.at(-1)!.length+word.length+1>limit)lines.push(word);
    else lines[lines.length-1]+=' '+word;
  }
  const longest=Math.max(heading.length,...lines.map(line=>line.length));
  return {width:Math.min(availableWidth,Math.max(28,longest*FONT*.62+PADDING*2)),height:25+lines.length*ROW,lines};
}

export default function OverlayLabel({x,y,heading,background,layout,accent='#94a3b8',anchor}:{x:number;y:number;heading:string;
  background:string;accent?:string;anchor?:string;layout:ReturnType<typeof overlayLabelLayout>}){
  return <svg className="observation-label" x={x} y={y} data-target-x={x} data-target-y={y} data-anchor-frame={anchor}
    data-warning={background==='#7f1d1d'} width={layout.width} height={layout.height}>
    <rect x={.5} y={.5} width={Math.max(0,layout.width-1)} height={layout.height-1} rx={2} fill={background} fillOpacity={.94}
      stroke={accent} strokeOpacity={.8} strokeWidth={1}/>
    <text x={PADDING} y={17} fill="#f8fafc" fontSize={FONT} fontWeight={600}>{heading}</text>
    {layout.lines.map((line,index)=><text key={index} x={PADDING} y={36+index*ROW}
      fill="#e2e8f0" fontSize={FONT} fontWeight={500}>{line}</text>)}
  </svg>;
}
