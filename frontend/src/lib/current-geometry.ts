import type {StudentTrack,TrackedObject} from './types';
import type {GeometryFrame} from './pixel-camera';

/** Semantics may be old; coordinates may only come from this pixel frame. */
export function currentGeometry(tracks:StudentTrack[],objects:TrackedObject[],frame:GeometryFrame){
  const boxes=new Map(frame.boxes.map(item=>[item.key,item.box]));
  return {
    tracks:tracks.flatMap(track=>{
      if(track.trackingState==='predicted')return [];
      const personBox=boxes.get('person:'+track.id),faceBox=boxes.get('face:'+track.id);
      const box=personBox??faceBox;if(!box)return [];
      return [{...track,box,personBox,faceBox,boxKind:personBox?'person' as const:'face' as const,
        displayBoxes:undefined,presentation:undefined,status:'visible' as const,
        faceVisibility:faceBox?'visible' as const:'unavailable' as const,
        trackingState:faceBox?'face' as const:'visual' as const}];
    }),
    objects:objects.flatMap(object=>{
      const box=boxes.get('object:'+object.id);return box?[{...object,box,displayBox:undefined}]:[];
    }),
  };
}
