import {AttentionEvaluator} from '../../../backend/src/attention.js';
import {observationSettingsSchema,parseObservationSettings} from '../../../backend/src/observation-settings.js';
import type {StudentTrack as MeasuredTrack} from '../../../backend/src/types.js';
import {normalizeDetectionSettings,readDetectionSettings} from './detection-settings';
import type {StudentTrack,TrackedObject} from './types';

export interface PlaybackMeasurements {
  at:number;
  tracks:[MeasuredTrack['observation']|null,NonNullable<MeasuredTrack['actions']>][];
  objects:TrackedObject[];
}

export interface EditablePlayback {
  sourceVersion:string;
  fps:number;
  keys:string[];
  frames:number[][];
  measurements:PlaybackMeasurements[];
}

export async function readEditablePlayback(data:string):Promise<EditablePlayback>{
  const bytes=Uint8Array.from(atob(data),character=>character.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
}

export function playbackEvaluator(){
  return new AttentionEvaluator(parseObservationSettings(
    normalizeDetectionSettings(observationSettingsSchema() as Parameters<typeof normalizeDetectionSettings>[0],readDetectionSettings())));
}

export function evaluatePlayback(evaluator:AttentionEvaluator,tracks:StudentTrack[],measurements:PlaybackMeasurements){
  return evaluator.evaluate(tracks.map((track,index)=>{
    const [observation,actions]=measurements.tracks[index]??[null,[]];
    return {...track,observation:observation??undefined,actions} as MeasuredTrack;
  }),measurements.at);
}
