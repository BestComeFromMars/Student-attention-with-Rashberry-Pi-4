export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedPerson {
  geometryFrameIds?:{person?:number;face?:number};
  personBox?: Box;
  faceBox?: Box;
  faceVisibility?: 'visible' | 'unavailable';
  personObservedAt?: number;
  actions?: ActionObservation[];
  objects?: ObjectRegion[];
  trackingState?: 'face' | 'visual' | 'body' | 'coasting' | 'predicted';
  geometryId?: number;
  personId?: number;
  analysisAt?: number;
  box: Box;
  confidence?: number;
  boxKind?: 'face' | 'person';
  observation?: FaceObservation;
}

export interface DeskRestObservation {
  active:boolean;
  confidence:number;
  personConfidence:number;
  personObservedAt?:number;
  candidateConfidence?:number;
  /** Two distinct images corroborated the same person and folded-body region. */
  temporalPerson?:boolean;
  /** Current analyzed image time, distinct from HTTP completion time. */
  imageAt?:number;
  /** A verified person's current specialist detection; never a new identity. */
  trackedBodyAt?:number;
  personConfirmedAt?:number;
  observedAt:number;
}

export interface FaceObservation {
  headPoseValid?:boolean;
  eyeValid?:boolean;
  deskRest?:DeskRestObservation;
  bodyPose?: BodyPose;
  objectRegions?: ObjectRegion[];
  valid: boolean;
  quality?: { usable: boolean; reason?: string | null; brightness: number; contrast: number; sharpness: number };
  facePresent?: boolean;
  eyeAspectRatio: number;
  leftEyeAspectRatio?: number | null;
  rightEyeAspectRatio?: number | null;
  yawOffset: number;
  observedAt?: number;
  objectsAt?: number;
  facePixels?: number;
  pitchDeg?: number | null;
  yawDeg?: number | null;
  headYaw?: number | null;
  headObservedAt?: number;
  headSource?: 'body_keypoints';
  mouthOpenRatio?: number | null;
  mouthOpenRatio2d?: number | null;
  mouthValid?: boolean;
  mouthSource?: 'face_landmarker' | 'profile_roi';
  jawOpen?: number | null;
  eyeBlinkLeft?: number | null;
  eyeBlinkRight?: number | null;
  mouthSmileLeft?: number | null;
  mouthSmileRight?: number | null;
  phoneHeld?: boolean | null;
  laptopInteraction?: boolean | null;
  bookInteraction?: boolean | null;
  cavtScore?: number | null;
  cavtAvailable?: boolean;
}
export type ActionKind = 'sit'|'stand'|'look_forward'|'look_sideways'|'read'|'flip_books'|'touch_sth'|
  'raise_hand'|'hands_down'|'take_notes'|'applaud'|'bend'|'turn_around'|'talk_with_others'|'answer_questions'|'slumped_on_desk';
export interface ActionObservation {
  type: ActionKind;
  label: string;
  state: 'unavailable'|'clear'|'pending'|'confirmed';
  source: 'MobileViCLIP-Tiny'|'MobileViCLIP-Small'|'SCB-YOLOv7';
  confidence?: number;
  evidenceBox?: Box;
  observedAt: number;
  clipStart?: number;
  similarity?: number;
  margin?: number;
  durationMs?: number;
  reason?: string;
}
export type AttentionState = 'focused' | 'uncertain' | 'needs_attention';

export interface BodyPose {
  keypoints: {x:number;y:number;confidence:number}[];
  confidence:number;
  aspectRatio:number;
  box:Box;
  observedAt:number;
  source:'YOLO11n-pose';
}
export interface ObservationCalibration {
  reference?:'camera';
  state:'collecting'|'ready'|'insufficient';
  headingReady:boolean;
  postureReady:boolean;
  startedAt:number;
  expiresAt:number;
}

export interface StudentTrack extends DetectedPerson {
  displayBoxes?:{box?:Box;person?:Box;face?:Box};
  calibration?:ObservationCalibration;
  actionAlert?: {type:ActionKind;label:string;observedAt:number;expiresAt:number};
  studyContext?: 'book';
  signals?: BehaviorSignal[];
  alerts?: BehaviorAlert[];
  attention?: AttentionState;
  reason?: string;
  id: string;
  displayName: string;
  color: string;
  lastSeen: number;
  status: 'visible' | 'lost';
}
export interface ObjectRegion {
  delayed?: boolean;
  interaction?: boolean;
  kind: 'phone' | 'book' | 'laptop';
  box: Box;
  confidence: number;
  observedAt: number;
}
export interface TrackedObject extends ObjectRegion {
  displayBox?:Box;
  id: string;
  trackedAt: number;
  trackingState: 'detected' | 'visual';
  ownerGeometryId?: number;
  ownerPersonId?: number;
  ownerId?: string;
}
export interface MemoryStatus {totalMB:number;availableMB:number;limit:number;detected:number;processed:number;limited:boolean;pressure:boolean;}
export interface FrameDetections { people: DetectedPerson[]; objects: TrackedObject[]; frameAt?:number; memory?:MemoryStatus; }
export interface BehaviorAlert {
  type: BehaviorSignal['type'];
  label: string;
  observedAt: number;
  expiresAt: number;
  held: boolean;
}
export interface BehaviorSignal {
  type: 'eyes_closed' | 'phone' | 'head_down' | 'yawn' | 'talking' | 'laptop' | 'head_turning' |
    'head_turned'|'torso_turned'|'turned_smiling'|'upper_body_slumped';
  label: string;
  state: 'unavailable' | 'clear' | 'pending' | 'confirmed';
  durationMs: number;
  observedAt?:number;
  cycles?: number;
}
export interface AICapabilities {
  behaviors: number;
  maxFaces: number;
  cavt: string;
  device: string;
  [key: string]: unknown;
}

export interface InferenceEngine {
  trackFrame?(jpeg:Buffer,context:{sessionId:string;frameId:number;capturedAt?:number}):Promise<import('./pixel-tracker.js').PixelFrame>;
  seedGeometry?(sessionId:string,seeds:import('./pixel-tracker.js').PixelSeed[]):void;
  startupState?: 'loading' | 'ready' | 'error';
  startupError?: string;
  detector?: 'classroom';
  capabilities?: AICapabilities;
  metrics?: Record<string, unknown>;
  ready: boolean;
  detect(jpeg: Buffer, context?: { sessionId: string; frameAt?:number }): Promise<DetectedPerson[]>;
  detectFrame?(jpeg: Buffer, context?: { sessionId: string; frameAt?:number;frameId?:number }): Promise<FrameDetections>;
  configure?(sessionId: string, features: import('./observation-settings.js').ActiveAIFeatures): void;
  release?(sessionId: string): void;
  close(): Promise<void>;
}
