import type {StudentTrack,TrackedObject} from '../lib/types';

/** Keep completed AI metadata immutable. AnimatedOverlays owns the independent
 * SVG render clock; pause/reset/source changes still clear the decision. */
export function useLiveOverlays(tracks:StudentTrack[],objects:TrackedObject[],running:boolean){
  return {tracks:running?tracks:[],objects:running?objects:[]};
}
