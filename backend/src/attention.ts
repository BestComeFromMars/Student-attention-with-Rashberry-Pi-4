import type { BehaviorSignal, StudentTrack } from './types.js';

import { HeadMotion } from './head-motion.js';
import { FacialBehavior } from './facial-behavior.js';
import type { BehaviorAlert, FaceObservation } from './types.js';
import { visibleObjects } from './object-context.js';
import { ActionEvaluator } from './actions.js';
import {PostureBehavior} from './posture-behavior.js';
import {defaultObservationSettings,type ObservationSettings} from './observation-settings.js';
import {bodyYawDegrees,configuredCameraYaw} from './camera-direction.js';

type Kind = BehaviorSignal['type'];
interface Timer { since: number | null; at: number; active: boolean; samples: number; }
interface History {
  owner?: number;
  timers: Map<string, Timer>;
  face: FacialBehavior;
  yawnSource?: FaceObservation['mouthSource'];
  headDown: boolean;
  pitchBaseline: number | null;
  head: HeadMotion;
  posture:PostureBehavior;
  alerts: Map<Kind, BehaviorAlert>;
  actionAlert?: StudentTrack['actionAlert'];
}
const COLORS = { uncertain: '#eab308', needs_attention: '#ef4444' };
const LABELS: Record<Kind, string> = {
  eyes_closed: 'Nhắm mắt kéo dài', phone: 'Cầm điện thoại', head_down: 'Cúi đầu',
  yawn: 'Có thể ngáp', talking: 'Có thể nói chuyện kéo dài', laptop: 'Tương tác laptop',
  head_turning: 'Quay đầu qua lại nhiều lần',
  head_turned:'Quay lệch hướng lâu',torso_turned:'Có dấu hiệu quay thân sang bên',
  turned_smiling:'Quay sang bên kèm cười',upper_body_slumped:'Có dấu hiệu gục đầu/thân trên',
};
const GAP = 2000;
const OBJECT_GAP = 5000;
// Specificity-first arbitration: composite/specific behaviors always win over
// generic parent postures (e.g., upper_body_slumped > head_down; talking /
// turned_smiling / torso_turned / head_turning > head_turned).
const PRIORITY:Kind[]=[
  'upper_body_slumped','phone','talking','yawn','turned_smiling','torso_turned',
  'head_turning','eyes_closed','head_turned','head_down','laptop',
];
export const ALERT_HOLD_MS = 5000;

function usable(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }

export class AttentionEvaluator {
  constructor(private readonly settings:ObservationSettings=defaultObservationSettings()){}
  private history = new Map<string, History>();
  private actions = new ActionEvaluator();
  private sample(history: History, key: string, active: boolean | null, at: number, now: number, required: number, gap = GAP) {
    let timer = history.timers.get(key);
    if (active === null || !usable(at) || now - at > gap || at > now + 1000) {
      history.timers.delete(key);
      return { state: 'unavailable' as const, durationMs: 0 };
    }
    if (!timer || at < timer.at || at - timer.at > gap) timer = { since: null, at: -1, active: false, samples: 0 };
    if (at !== timer.at) {
      timer.since = active ? timer.active ? timer.since ?? at : at : null;
      timer.samples = active ? timer.active ? timer.samples + 1 : 1 : 0;
      timer.active = active;
      timer.at = at;
    }
    history.timers.set(key, timer);
    const durationMs = timer.since === null ? 0 : Math.max(0, timer.at - timer.since);
    return {
      state: !timer.active ? 'clear' as const : durationMs >= required && timer.samples >= 2 ? 'confirmed' as const : 'pending' as const,
      durationMs,
    };
  }

  evaluate(tracks: StudentTrack[], now: number): StudentTrack[] {
    const ids = new Set(tracks.map(track => track.id));
    this.actions.retain(ids);
    for (const id of this.history.keys()) if (!ids.has(id)) this.history.delete(id);
    return tracks.map(track => {
      let history = this.history.get(track.id);
      if (!history || (history.owner != null && track.personId != null && history.owner !== track.personId)) {
        history = { owner: track.personId, timers: new Map(), face: new FacialBehavior(this.settings.thresholds), headDown: false, pitchBaseline: null,
          head: new HeadMotion(this.settings.thresholds),posture:new PostureBehavior(now,configuredCameraYaw(),this.settings.thresholds), alerts: new Map() };
        this.history.set(track.id, history);
      }
      history.owner ??= track.personId;
      const actions=this.actions.evaluate(track.id,track.status==='visible'?track.actions?.map(action=>({...action})):track.actions?.map(action=>({...action,state:'unavailable'})),now);
      const sleep=this.settings.enabled.upper_body_slumped&&actions.find(action=>action.type==='slumped_on_desk'&&action.state==='confirmed');
      if(sleep&&(!history.actionAlert||sleep.observedAt>history.actionAlert.observedAt))history.actionAlert={type:sleep.type,label:sleep.label,observedAt:sleep.observedAt,expiresAt:now+ALERT_HOLD_MS};
      if(!sleep||(history.actionAlert&&now>=history.actionAlert.expiresAt))history.actionAlert=undefined;
      const observation = track.observation;
      const objectsEnabled=this.settings.objectsEnabled;
      const objects = objectsEnabled?visibleObjects(track, now):[];
      const unresolvedObject = objectsEnabled&&objects.some(object => object.interaction === false && object.kind !== 'book');
      const faceAt = observation?.observedAt ?? now;
      const objectsAt = observation?.objectsAt ?? faceAt;
      const reliableImage = observation?.quality?.usable !== false;
      const faceValid = reliableImage && track.status === 'visible' && track.faceVisibility!=='unavailable' && observation?.valid === true && usable(faceAt)
        && now-faceAt <= GAP && faceAt <= now+1000 &&
        (observation.facePixels === undefined || (usable(observation.facePixels) && observation.facePixels >= 18));
      const mouthValid = faceValid || (reliableImage && track.status === 'visible' && track.faceVisibility!=='unavailable' && observation?.mouthValid === true &&
        usable(faceAt) && now-faceAt <= GAP && faceAt <= now+1000 &&
        usable(observation.facePixels) && observation.facePixels >= 18);
      const pitch = observation?.pitchDeg;
      const poseValid=faceValid||mouthValid||(reliableImage&&track.status==='visible'&&track.faceVisibility!=='unavailable'&&
        observation?.headPoseValid===true&&usable(faceAt)&&now-faceAt<=GAP&&faceAt<=now+1000);
      const cues = history.face.update(observation, faceAt, faceValid, mouthValid);
      const thresholds=this.settings.thresholds;
      let headDownActive: boolean | null = null;
      let headDownAt = faceAt;
      if (poseValid && usable(pitch)) {
        // Compensate low-mounted (negative upright pitch) and top-down classroom
        // (positive upright pitch ~8-11 deg) cameras while keeping genuine bows detectable.
        if (pitch <= 14 && !history.headDown) {
          const clamped = Math.max(-22, Math.min(10, pitch));
          history.pitchBaseline = history.pitchBaseline === null ? clamped : history.pitchBaseline * 0.85 + clamped * 0.15;
        }
        const offset = Math.max(-22, Math.min(10, history.pitchBaseline ?? 0));
        const effectivePitch = pitch - offset;
        history.headDown = effectivePitch >= (thresholds.headDownPitchDeg-(history.headDown?2:0));
        headDownActive = history.headDown;
      } else {
        const bp = track.status === 'visible' ? observation?.bodyPose : undefined;
        const kp = bp && usable(bp.observedAt) && now - bp.observedAt <= GAP && bp.keypoints?.length === 17 ? bp.keypoints : null;
        const ls = kp && kp[5].confidence >= .35 ? kp[5] : null;
        const rs = kp && kp[6].confidence >= .35 ? kp[6] : null;
        const headPts = kp ? [kp[0], kp[1], kp[2], kp[3], kp[4]].filter(p => p.confidence >= .35) : [];
        if (ls && rs && headPts.length) {
          const span = Math.hypot((ls.x - rs.x) * (bp!.aspectRatio || 1), ls.y - rs.y);
          const shY = (ls.y + rs.y) / 2;
          const headY = kp![0].confidence >= .35 ? kp![0].y : Math.max(...headPts.map(p => p.y));
          if (span >= .02) {
            history.headDown = headY >= shY - (history.headDown ? .15 : .10) * span;
            headDownActive = history.headDown;
            headDownAt = bp!.observedAt;
          } else history.headDown = false;
        } else history.headDown = false;
      }
      const reading = this.sample(history, 'book_context', objectsEnabled && track.status === 'visible'
        ? observation?.bookInteraction === true && observation?.phoneHeld !== true && observation?.laptopInteraction !== true
        : null, objectsAt, now, 1000, OBJECT_GAP);
      const studyAction=actions.some(action=>(action.type==='read'||action.type==='take_notes')&&action.state==='confirmed');
      const studying = reading.state === 'confirmed'||studyAction;
      const signals: BehaviorSignal[] = [];
      const add = (type: Kind, active: boolean | null, at: number, duration: number) => {
        signals.push({ type, label: LABELS[type], ...this.sample(history!, type, active, at, now, duration,
          type==='phone'||type==='laptop'?OBJECT_GAP:GAP) });
      };
      add('eyes_closed', cues.eyeClosed, faceAt, thresholds.eyesClosedMs);
      add('phone', objectsEnabled && track.status === 'visible' ? observation?.phoneHeld ?? null : null, objectsAt, thresholds.phoneMs);
      add('head_down', headDownActive, headDownAt, thresholds.headDownMs);
      if(cues.yawn!==null&&history.yawnSource!==observation?.mouthSource){
        history.yawnSource=observation?.mouthSource;
        history.timers.delete('yawn');
      }
      add('yawn', cues.yawn, faceAt, thresholds.yawnMs);

      signals.push({ type: 'talking', label: LABELS.talking,
        ...cues.talking, cycles: cues.mouthCycles });
      add('laptop', objectsEnabled && track.status === 'visible' ? observation?.laptopInteraction ?? null : null, objectsAt, thresholds.laptopMs);
      const faceHeading = poseValid && usable(observation?.yawDeg);
      const bodyAt = observation?.headObservedAt;
      const bodyHeading = track.status === 'visible' && usable(observation?.headYaw) && Math.abs(observation.headYaw)<=1 &&
        usable(bodyAt) && bodyAt<=now && now-bodyAt<=GAP;
      // A cached face pose should not mask newer body evidence as the face turns out of view.
      const useFaceHeading = faceHeading && (!bodyHeading || bodyAt-faceAt<750);
      const headAt = useFaceHeading ? faceAt : bodyHeading ? bodyAt : now;
      const yaw=useFaceHeading?observation!.yawDeg!:bodyHeading?bodyYawDegrees(observation!.headYaw!):null;
      const headSource=useFaceHeading?'face_pose':'body_keypoints';
      signals.push(history.head.update(track.status !== 'visible'||yaw===null ? null : Math.max(-1,Math.min(1,(yaw-configuredCameraYaw())/90)), headAt, now,
        yaw===null?undefined:headSource));
      const posture=history.posture.update({
        heading:yaw===null?null:{value:yaw,source:headSource,at:headAt},
        pose:track.status==='visible'?observation?.bodyPose:undefined,pitch:faceValid?pitch:null,
        deskRest:track.status==='visible'?observation?.deskRest:undefined,
        smile:mouthValid&&usable(observation?.mouthSmileLeft)&&usable(observation?.mouthSmileRight)?
          {left:observation!.mouthSmileLeft!,right:observation!.mouthSmileRight!,at:faceAt}:null,
      },now);
      signals.push(...posture.signals);
      for(const signal of signals)if(!this.settings.enabled[signal.type]||(!objectsEnabled&&(signal.type==='phone'||signal.type==='laptop'))){
        signal.state='unavailable';signal.durationMs=0;
      }
      const confirmed = signals.filter(signal => signal.state === 'confirmed' && !(signal.type === 'head_down' && studying))
        .sort((a,b)=>PRIORITY.indexOf(a.type)-PRIORITY.indexOf(b.type));
      const warning = confirmed[0];
      for (const signal of confirmed) {
        const observedAt = signal.observedAt??(signal.type === 'head_turning' ? headAt : signal.type === 'phone' || signal.type === 'laptop' ? objectsAt : faceAt);
        const previous = history.alerts.get(signal.type);
        // Retain the display, never invent current evidence or extend its
        // duration from repeated HTTP replies carrying the same measurement.
        if (!previous || observedAt > previous.observedAt) {
          history.alerts.set(signal.type, { type: signal.type, label: signal.label,
            observedAt, expiresAt: now + ALERT_HOLD_MS, held: false });
        }
      }
      for (const signal of signals) {
        if (signal.state === 'clear' || signal.state === 'pending') history.alerts.delete(signal.type);
      }
      for (const [type, alert] of history.alerts) if (now >= alert.expiresAt) history.alerts.delete(type);
      const alerts = [...history.alerts.values()].map(alert => ({ ...alert,
        held: !confirmed.some(signal => signal.type === alert.type) }))
        .sort((a,b) => Number(a.held)-Number(b.held) || PRIORITY.indexOf(a.type)-PRIORITY.indexOf(b.type) || b.observedAt-a.observedAt);
      const significantPending = signals.some(signal => signal.state === 'pending');
      const publish = (attention: keyof typeof COLORS, reason: string): StudentTrack =>
        ({ ...track, signals, alerts,calibration:posture.calibration, actions,actionAlert:history!.actionAlert,attention, color: COLORS[attention], reason,
          objects, studyContext: studying ? 'book' : undefined });
      if (warning) return publish('needs_attention', warning.label);
      if (alerts.length) return publish('needs_attention', 'Vừa ghi nhận: ' + alerts[0].label);
      if(history.actionAlert)return publish('needs_attention',history.actionAlert.label);
      if (unresolvedObject) return publish('uncertain', 'Phát hiện đồ vật gần học sinh; chưa xác nhận tương tác tay');
      if (significantPending) return publish('uncertain', 'Đang tích lũy bằng chứng hành vi theo thời gian');
      if (!reliableImage) return publish('uncertain', observation?.quality?.reason === 'too_dark'
        ? 'Ánh sáng yếu; hệ thống vẫn đang nhận diện' : 'Ảnh mờ; hệ thống vẫn đang nhận diện');
      if (studying) return publish('uncertain', 'Quan sát thấy tương tác sách/vở hoặc hành động đọc/ghi bài');
      if(posture.calibration.state==='collecting'&&!posture.calibration.headingReady)
        return publish('uncertain','AI đang quan sát và lấy hướng chuẩn');
      if(posture.calibration.state==='insufficient')return publish('uncertain','AI đang quan sát; chưa đủ dữ liệu hướng chuẩn');
      return publish('uncertain', track.status === 'lost' ? 'Tạm mất dấu người' : track.faceVisibility === 'unavailable'
        ? 'AI đang theo dõi người; chưa quan sát rõ khuôn mặt' : 'AI đang quan sát');
    });
  }
}

