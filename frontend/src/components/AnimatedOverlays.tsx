import {useLayoutEffect,useRef} from 'react';
import type {StudentTrack,TrackedObject} from '../lib/types';
import {OverlayMotion} from '../lib/overlay-motion';
import {useElementSize} from '../hooks/useElementSize';
import PersonOverlay from './PersonOverlay';
import FaceOverlay from './FaceOverlay';
import ObjectOverlay from './ObjectOverlay';
import type {OverlayLayoutState} from './OverlayLabel';

/** Animation mutates only SVG geometry; React and camera playback never run
 * on the animation clock. Explicit time is used by the native-FPS exporter. */
export default function AnimatedOverlays({tracks,objects,layoutState,scope='',at,motion,instant=false}:{
  tracks:StudentTrack[];objects:TrackedObject[];layoutState:OverlayLayoutState;scope?:string;at?:number;motion?:OverlayMotion;instant?:boolean;
}){
  const {ref:root,...size}=useElementSize<HTMLDivElement>();
  const local=useRef<OverlayMotion|null>(null);
  if(!local.current)local.current=new OverlayMotion();
  const animator=motion??local.current;
  useLayoutEffect(()=>{
    if(!instant&&root.current)animator.retarget(root.current,at??performance.now(),scope,at===undefined);
  },[tracks,objects,scope,at,animator,instant]);
  useLayoutEffect(()=>{
    const element=root.current;if(!element||instant)return;
    const observer=new MutationObserver(()=>animator.discover(element,at??performance.now()));
    observer.observe(element,{childList:true,subtree:true,attributes:true,
      attributeFilter:['data-target-x','data-target-y','data-target-width','data-target-height',
        'data-target-x1','data-target-y1','data-target-x2','data-target-y2']});
    return ()=>{observer.disconnect();animator.reset();};
  },[animator,instant]);
  return <div ref={root} className="live-overlays" style={{position:'absolute',inset:0,pointerEvents:'none'}}>
    <PersonOverlay tracks={tracks} layoutState={layoutState} size={size}/><FaceOverlay tracks={tracks} size={size}/>
    <ObjectOverlay objects={objects} tracks={tracks} layoutState={layoutState} size={size}/>
  </div>;
}
