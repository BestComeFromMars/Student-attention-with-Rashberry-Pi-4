import type { FaceObservation } from './types.js';
import { SpeechMotion } from './speech-motion.js';
import {defaultObservationSettings,type ObservationSettings} from './observation-settings.js';

type SignalState = 'clear' | 'pending' | 'confirmed' | 'unavailable';
interface Cues {
  eyeClosed: boolean | null;
  eyesOpen: boolean;
  yawn: boolean | null;
  talking: { state: SignalState; durationMs: number; observedAt?:number };
  mouthCycles: number;
}
const available = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const unknownCues = (): Cues => ({ eyeClosed: null, eyesOpen: false, yawn: null,
  talking: { state: 'unavailable', durationMs: 0 }, mouthCycles: 0 });

/** A per-person reference; repeated HTTP replies never enter this history. */
class Baseline {
  private samples: { at: number; value: number }[] = [];
  private reference: number | null = null;
  constructor(private quantile: number, private minimum = 3, private span = 500) {}
  add(at: number, value: number) {
    this.samples.push({ at, value });
    if (this.samples.length > 180) this.samples.shift();
  }
  value(at: number) {
    this.samples = this.samples.filter(sample => at - sample.at <= 15000);
    // Keep the learned open-eye reference during a long closure. Expiring it could
    // otherwise reinterpret the same closed eyes as a new normal after 15 seconds.
    if (this.samples.length < this.minimum || this.samples[this.samples.length - 1].at - this.samples[0].at < this.span) return this.reference;
    const values = this.samples.map(sample => sample.value).sort((a, b) => a - b);
    this.reference = values[Math.floor((values.length - 1) * this.quantile)];
    return this.reference;
  }
}

/** Interpret fresh face measurements before applying the documented duration rules. */
export class FacialBehavior {
  constructor(private readonly thresholds:ObservationSettings['thresholds']=defaultObservationSettings().thresholds){this.speech=new SpeechMotion(thresholds);}
  private lastAt: number | null = null;
  private last = unknownCues();
  private closed = false;
  private yawning = false;
  private yawnSource: FaceObservation['mouthSource'];
  private yawnSince:number|null=null;
  private speech:SpeechMotion;
  private speechAt: number | null = null;
  private mouthSource: FaceObservation['mouthSource'];
  private speechPose:{yaw:number|null;pitch:number|null;at:number}|null=null;
  private baselines = this.newBaselines();

  private newBaselines() {
    return { eye: new Baseline(.8, 3, 400), leftEye: new Baseline(.8, 3, 400),
      rightEye: new Baseline(.8, 3, 400) };
  }
  private reset() {
    this.lastAt = null;
    this.closed = this.yawning = false;
    this.yawnSource=undefined;
    this.yawnSince=null;
    this.clearSpeech();
    this.baselines = this.newBaselines();
    this.last = unknownCues();
  }
  private clearSpeech() {
    this.speechAt = null;
    this.mouthSource = undefined;
    this.speechPose=null;
    this.speech.clear();
  }

  update(observation: FaceObservation | undefined, at: number, valid: boolean, mouthValid = valid): Cues {
    if (!observation || (!valid && !mouthValid)) {
      // Brief profile landmark dropouts suspend the published evidence. They do
      // not erase completed cycles until 650 ms without a fresh mouth sample.
      if (this.speechAt !== null && at >= this.speechAt && at-this.speechAt <= 650) {
        this.closed = this.yawning = false;
        this.yawnSince=null;
        this.baselines = this.newBaselines();
        this.last = unknownCues();
      } else this.reset();
      return this.last;
    }
    if (this.lastAt !== null && (at < this.lastAt || at - this.lastAt > 2000)) this.reset();
    if (at === this.lastAt) return this.last;
    this.lastAt = at;
    const eyesValid=valid&&observation.eyeValid!==false;
    const ear = eyesValid ? observation.eyeAspectRatio : undefined;
    const leftEar = eyesValid ? observation.leftEyeAspectRatio : undefined;
    const rightEar = eyesValid ? observation.rightEyeAspectRatio : undefined;
    const leftBlink = eyesValid ? observation.eyeBlinkLeft : undefined;
    const rightBlink = eyesValid ? observation.eyeBlinkRight : undefined;
    const blinkKnown = available(leftBlink) && available(rightBlink);
    const blink = blinkKnown ? (leftBlink + rightBlink) / 2 : 0;
    const minBlink = blinkKnown ? Math.min(leftBlink, rightBlink) : 0;
    const threshold = (baseline: Baseline) => {
      const reference = baseline.value(at);
      return reference === null ? (blinkKnown ? (this.closed ? .18 : .16) : (this.closed ? .21 : .19))
        : Math.min(this.closed ? .28 : .24, Math.max(this.closed ? .16 : .14, reference * (this.closed ? .78 : .68)));
    };
    const bothEyeRatios = available(leftEar) && available(rightEar);
    const bothClosed = bothEyeRatios && leftEar <= threshold(this.baselines.leftEye) && rightEar <= threshold(this.baselines.rightEye);
    const geometryClosed = available(ear) && ear <= threshold(this.baselines.eye) && (!bothEyeRatios || bothClosed);
    // Clear geometric closure and strong bilateral blendshapes are independent evidence.
    const supportedClosure = available(ear) && ear < Math.max(this.closed ? .22 : .20, threshold(this.baselines.eye) * 1.06) && blinkKnown &&
      blink >= (this.closed ? .32 : .40) && minBlink >= (this.closed ? .18 : .22);
    const blendClosure = blinkKnown && blink >= (this.closed ? .55 : .68) && minBlink >= (this.closed ? .45 : .58);
    const wink = blinkKnown && Math.abs(leftBlink - rightBlink) > .6 && minBlink < .2 && !bothClosed;
    const eyeClosed = available(ear) || blinkKnown ? !wink && (geometryClosed || supportedClosure || blendClosure) : null;
    this.closed = eyeClosed === true;
    const eyesOpen = available(ear) && eyeClosed === false && (blinkKnown ? blink < .55 && ear >= .12 : ear >= .20);
    const yaw = observation.yawDeg ?? (Number.isFinite(observation.yawOffset) ? observation.yawOffset * 90 : null);
    if (eyesOpen && available(ear) && (!blinkKnown || blink < .4) && typeof yaw === 'number' && Math.abs(yaw) <= 25 &&
        (observation.pitchDeg == null || Math.abs(observation.pitchDeg) <= 20)) {
      this.baselines.eye.add(at, ear);
      if (available(leftEar)) this.baselines.leftEye.add(at, leftEar);
      if (available(rightEar)) this.baselines.rightEye.add(at, rightEar);
    }

    const mouth = observation.mouthOpenRatio;
    const jaw = observation.jawOpen;
    // This is a geometric distance ratio, not a blendshape probability; a very
    // wide opening or a turned face can legitimately produce a ratio above one.
    const mouthKnown = typeof mouth === 'number' && Number.isFinite(mouth) && mouth >= 0;
    const jawKnown = available(jaw);
    // A moderate speech vowel plus a high jaw blendshape is not sufficient
    // yawning evidence. The weaker aperture route needs bilateral eye squeeze.
    const eyeSqueeze=blinkKnown&&blink>=.55&&minBlink>=.35;
    if(this.yawnSource!==observation.mouthSource){
      this.yawning=false;
      this.yawnSince=null;
      this.yawnSource=observation.mouthSource;
    }
    const profileMouth=mouthValid&&observation.mouthSource==='profile_roi'&&
      (observation.facePixels??0)>=64&&observation.quality?.usable!==false;
    const yawn = valid && (mouthKnown || jawKnown) ?
      (mouthKnown && (mouth >= (this.yawning ? .43 : .52) ||
        (eyeSqueeze&&jawKnown && mouth >= (this.yawning ? .28 : .35) && jaw >= (this.yawning ? .45 : .55)))) ||
      (!mouthKnown && eyeSqueeze&&jawKnown && jaw >= (this.yawning ? .60 : .70)) :
      profileMouth&&mouthKnown ? mouth >= (this.yawning ? .60 : .70) : null;
    this.yawning = yawn === true;
    if(yawn)this.yawnSince??=at;else this.yawnSince=null;
    const sustainedYawn=this.yawnSince!==null&&at-this.yawnSince>=this.thresholds.yawnMs;

    let talking: Cues['talking'] = { state: 'unavailable', durationMs: 0 };
    const speechImage=observation.quality?.usable!==false&&
      (observation.facePixels===undefined||Number.isFinite(observation.facePixels)&&observation.facePixels>=52);
    if ((mouthKnown || jawKnown)&&speechImage) {
      if (this.mouthSource !== observation.mouthSource) this.clearSpeech();
      this.mouthSource = observation.mouthSource;
      this.speechAt = at;
      const pitch=typeof observation.pitchDeg==='number'&&Number.isFinite(observation.pitchDeg)?observation.pitchDeg:null;
      const speechYaw=typeof yaw==='number'&&Number.isFinite(yaw)?yaw:null;
      const poseDt=this.speechPose?at-this.speechPose.at:0;
      const poseLimit=poseDt<=300?13:22;
      const poseJump=this.speechPose&&at>this.speechPose.at&&poseDt<=750&&
        (speechYaw!==null&&this.speechPose.yaw!==null&&Math.abs(speechYaw-this.speechPose.yaw)>poseLimit||
          pitch!==null&&this.speechPose.pitch!==null&&Math.abs(pitch-this.speechPose.pitch)>poseLimit);
      this.speechPose={yaw:speechYaw,pitch,at};
      const smiling=available(observation.mouthSmileLeft)&&available(observation.mouthSmileRight)&&
        (observation.mouthSmileLeft+observation.mouthSmileRight)/2>=.45&&Math.min(observation.mouthSmileLeft,observation.mouthSmileRight)>=.3;
      if (sustainedYawn||poseJump) {
        this.speech.clear();
      } else if (!smiling) {
        this.speech.update(mouthKnown ? mouth : null, jawKnown ? jaw : null, at);
      }
      const { count, durationMs,observedAt,active } = this.speech.evidence;
      talking = { state: yawn||smiling ? 'clear' : poseJump?'unavailable':active&&count >= 2 && durationMs >= this.thresholds.talkingMs ? 'confirmed'
        : (active&&count>0)||this.speech.pending ? 'pending' : 'clear', durationMs,observedAt };
    } else this.clearSpeech();

    this.last = { eyeClosed, eyesOpen, yawn, talking, mouthCycles: this.speech.evidence.count };
    return this.last;
  }
}
