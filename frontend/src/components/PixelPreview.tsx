import {useLayoutEffect,useRef,useState} from 'react';
import {flushSync} from 'react-dom';
import type {ObservationSession} from '../lib/session';
import type {StudentTrack,TrackedObject} from '../lib/types';
import {currentGeometry} from '../lib/current-geometry';
import AnimatedOverlays from './AnimatedOverlays';
import {createOverlayLayoutState} from './OverlayLabel';

export default function PixelPreview({session,scope}:{session:ObservationSession;scope:string}){
  const canvas=useRef<HTMLCanvasElement>(null),layout=useRef(createOverlayLayoutState());
  const [geometry,setGeometry]=useState<{tracks:StudentTrack[];objects:TrackedObject[]}>({tracks:[],objects:[]});
  useLayoutEffect(()=>session.attachPresenter(frame=>{
    const target=canvas.current;if(!target)return;
    if(!frame){target.style.visibility='hidden';flushSync(()=>setGeometry({tracks:[],objects:[]}));return;}
    const context=target.getContext('2d',{alpha:false});if(!context)return;
    const state=session.getSnapshot(),shown=currentGeometry(state.tracks,state.objects??[],frame);
    if(target.width!==frame.image.width||target.height!==frame.image.height){target.width=frame.image.width;target.height=frame.image.height;}
    // A browser cannot paint in the middle of this task: image + SVG commit
    // atomically. There is no interpolation toward an old AI rectangle.
    context.drawImage(frame.image,0,0);
    flushSync(()=>setGeometry(shown));
    target.dataset.frameId=String(frame.frameId);
    target.dataset.geometryFrameId=String(frame.frameId);
    target.dataset.mediaTime=String(frame.mediaTime);
    target.dataset.captureAgeMs=String(performance.now()-frame.capturedAt);
    target.style.visibility='visible';
    target.dispatchEvent(new CustomEvent('pixelpresented',{bubbles:true,detail:{frameId:frame.frameId,
      geometryFrameId:frame.frameId,mediaTime:frame.mediaTime,capturedAt:frame.capturedAt,
      presentedAt:performance.now(),processingMs:frame.processingMs,boxes:frame.boxes}}));
  }),[session,scope]);
  return <><canvas ref={canvas} className="pixel-preview" aria-label="Video và bbox cùng khung hình"
    style={{position:'absolute',inset:0,width:'100%',height:'100%',visibility:'hidden'}}/>
    <AnimatedOverlays tracks={geometry.tracks} objects={geometry.objects} scope={scope} layoutState={layout.current} instant/>
  </>;
}
