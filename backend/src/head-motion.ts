import type { BehaviorSignal } from './types.js';
import {defaultObservationSettings,type ObservationSettings} from './observation-settings.js';

export const HEAD_TURN_WINDOW_MS = 10000;
export const HEAD_TURN_GAP_MS = 3000;

/** Count sustained orientation changes from fresh signed measurements per person. */
export class HeadMotion {
  constructor(private readonly thresholds:ObservationSettings['thresholds']=defaultObservationSettings().thresholds){}
  private state={lastAt:-Infinity,zone:null as number|null,candidate:null as {zone:number;since:number}|null,changes:[] as number[],changedAt:-Infinity};

  update(yaw: number | null, at: number, now: number, _source?: string): BehaviorSignal {
    const state=this.state;
    if(now-state.lastAt>HEAD_TURN_GAP_MS){state.zone=null;state.candidate=null;state.changes=[];}
    state.changes=state.changes.filter(stamp=>now-stamp<=this.thresholds.headTurnWindowMs);
    const available = yaw !== null && Number.isFinite(yaw) && Math.abs(yaw) <= 1 &&
      Number.isFinite(at) && at <= now + 1000 && now - at <= 2000 && at >= state.lastAt;
    if (!available) state.candidate = null;
    if (available && at > state.lastAt) {
      if (at - state.lastAt > HEAD_TURN_GAP_MS) {
        state.zone = null; state.candidate = null;state.changes=[];
      }
      if (state.changes.length >= this.thresholds.headTurnChanges && at - state.changedAt > 1500) {
        state.changes = [];
      }
      const turnAngle=this.thresholds.headTurnAngleDeg/90;
      const holdAngle=turnAngle*.85;
      const prevAt=state.lastAt;
      state.lastAt = at;
      const rawZone = yaw! <= -turnAngle ? -1 : yaw! >= turnAngle ? 1 : Math.abs(yaw!) <= .18 ? 0 : null;
      const zone = rawZone !== null ? rawZone
        : state.candidate?.zone === -1 && yaw! <= -holdAngle ? -1
        : state.candidate?.zone === 1 && yaw! >= holdAngle ? 1
        : null;
      if (zone === null || zone === state.zone) state.candidate = null;
      else if (state.zone !== null && state.zone * zone === -1 && prevAt > -Infinity && at - prevAt >= 180 && at - state.changedAt >= 250) {
        // Direct full opposite-side turn (-1 <-> +1) over a real frame interval.
        state.changes.push(at); state.changedAt = at;
        state.zone = zone; state.candidate = null;
      } else if (state.candidate?.zone !== zone) state.candidate = { zone, since: at };
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
