import type { BehaviorSignal } from './types.js';
import {defaultObservationSettings,type ObservationSettings} from './observation-settings.js';

export const HEAD_TURN_WINDOW_MS = 10000;
export const HEAD_TURN_GAP_MS = 3000;

/** Count sustained orientation changes from fresh signed measurements per person. */
export class HeadMotion {
  constructor(private readonly thresholds:ObservationSettings['thresholds']=defaultObservationSettings().thresholds){}
  private sources=new Map<string,{lastAt:number;zone:number|null;candidate:{zone:number;since:number}|null;changes:number[];changedAt:number}>();
  private lastPublishedAt=-Infinity;
  private lastSource='default';

  update(yaw: number | null, at: number, now: number, source?: string): BehaviorSignal {
    for(const [key,state]of this.sources)if(now-state.lastAt>HEAD_TURN_GAP_MS)this.sources.delete(key);
    const key=source??this.lastSource;
    let state=this.sources.get(key);
    if(!state){state={lastAt:-Infinity,zone:null,candidate:null,changes:[],changedAt:-Infinity};this.sources.set(key,state);}
    state.changes=state.changes.filter(stamp=>now-stamp<=this.thresholds.headTurnWindowMs);
    const available = yaw !== null && Number.isFinite(yaw) && Math.abs(yaw) <= 1 &&
      Number.isFinite(at) && at <= now + 1000 && now - at <= 2000 && at >= state.lastAt&&at>=this.lastPublishedAt;
    if (!available) state.candidate = null;
    if (available && at > state.lastAt) {
      if (at - state.lastAt > HEAD_TURN_GAP_MS) {
        state.zone = null; state.candidate = null;state.changes=[];
      }
      if (state.changes.length >= this.thresholds.headTurnChanges && at - state.changedAt > 1500) {
        state.changes = [];
      }
      state.lastAt = at;
      this.lastPublishedAt=at;this.lastSource=key;
      const turnAngle=this.thresholds.headTurnAngleDeg/90;
      const zone = yaw! <= -turnAngle ? -1 : yaw! >= turnAngle ? 1 : Math.abs(yaw!) <= .12 ? 0 : null;
      if (zone === null || zone === state.zone) state.candidate = null;
      else if (state.candidate?.zone !== zone) state.candidate = { zone, since: at };
      else if (at - state.candidate.since >= 120) {
        if (state.zone !== null && at - state.changedAt >= 250) {
          state.changes.push(at); state.changedAt = at;
        }
        state.zone = zone; state.candidate = null;
      }
    }
    return { type: 'head_turning', label: 'Quay đầu qua lại nhiều lần',
      state: !available ? 'unavailable' : state.changes.length >= this.thresholds.headTurnChanges ? 'confirmed' : state.changes.length ? 'pending' : 'clear',
      cycles: state.changes.length,
      durationMs: state.changes.length ? state.changes[state.changes.length - 1] - state.changes[0] : 0 };
  }
}
