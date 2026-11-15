import {useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import FaceOverlay from '../src/components/FaceOverlay';
import ObjectOverlay from '../src/components/ObjectOverlay';
import PersonOverlay from '../src/components/PersonOverlay';
import AnimatedOverlays from '../src/components/AnimatedOverlays';
import {OverlayMotion} from '../src/lib/overlay-motion';
import {createOverlayLayoutState,personLabelPlacements,type OverlayLayoutState,type LabelRect} from '../src/components/OverlayLabel';
import type {StudentTrack,TrackedObject} from '../src/lib/types';
import {currentGeometry} from '../src/lib/current-geometry';
import type {GeometryFrame} from '../src/lib/pixel-camera';
import '../src/styles.css';

type Frame={image:string;tracks:StudentTrack[];objects:TrackedObject[];at?:number;geometry?:GeometryFrame};
type ExportSnapshot={layout:OverlayLayoutState;labels:Record<string,LabelRect>;baseline:Record<string,LabelRect>};
declare global {interface Window {renderExportFrame:(frame:Frame)=>Promise<ExportSnapshot>;advanceExportOverlay:(at:number)=>void;restoreExportOverlayState:(state:OverlayLayoutState)=>void;exportReady:boolean;}}
const width=Number(new URLSearchParams(location.search).get('width'));
const height=Number(new URLSearchParams(location.search).get('height'));
const overlayOnly=new URLSearchParams(location.search).get('overlay')==='1';
const smooth=new URLSearchParams(location.search).get('smooth')==='1';

function VideoFrame(){
  const [frame,setFrame]=useState<Frame>({image:'',tracks:[],objects:[]});
  const layoutState=useRef(createOverlayLayoutState());
  const animator=useRef(new OverlayMotion());
  window.advanceExportOverlay=at=>animator.current.draw(at);
  window.restoreExportOverlayState=state=>{layoutState.current=state;};
  window.renderExportFrame=async next=>{
    if(next.geometry)next={...next,...currentGeometry(next.tracks,next.objects,next.geometry)};
    flushSync(()=>setFrame(next));
    const image=document.getElementById('export-source-image') as HTMLImageElement;
    if(!overlayOnly&&(!image.complete||!image.naturalWidth))await image.decode();
    return {layout:layoutState.current,labels:Object.fromEntries(Object.entries(layoutState.current.people).map(([id,value])=>[id,value.rect])),
      baseline:Object.fromEntries([...personLabelPlacements(next.tracks.map(track=>({...track,displayBoxes:undefined})),width,height)].map(([id,value])=>[id,value.rect]))};
  };
  window.exportReady=true;
  return <div className="video-viewport" style={{width,height,maxWidth:'none',maxHeight:'none',borderRadius:0,background:overlayOnly?'transparent':undefined}}>
    <img id="export-source-image" hidden={overlayOnly} style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'contain'}} src={frame.image||undefined}/>
    {smooth?<AnimatedOverlays tracks={frame.tracks} objects={frame.objects} at={frame.at??0}
      layoutState={layoutState.current} motion={animator.current}/>:<><PersonOverlay tracks={frame.tracks} layoutState={layoutState.current}/>
    <FaceOverlay tracks={frame.tracks}/>
    <ObjectOverlay objects={frame.objects} tracks={frame.tracks} layoutState={layoutState.current}/></>}
  </div>;
}

document.body.style.margin='0';document.body.style.overflow='hidden';
if(overlayOnly)for(const element of [document.documentElement,document.body,document.getElementById('root')!])element.style.background='transparent';
createRoot(document.getElementById('root')!).render(<VideoFrame/>);
