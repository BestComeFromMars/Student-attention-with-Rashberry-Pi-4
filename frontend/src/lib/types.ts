export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedPerson {
  personBox?: Box;
  faceBox?: Box;
  faceVisibility?: 'visible' | 'unavailable';
  personObservedAt?: number;
  actions?: ActionObservation[];
  objects?: ObjectRegion[];
  geometryId?:number;
  trackingState?: 'face' | 'visual' | 'body' | 'coasting' | 'predicted';
  box: Box;
  confidence?: number;
  boxKind?: 'face'|'person';
}
export interface ActionObservation {
  type:'sit'|'stand'|'look_forward'|'look_sideways'|'read'|'flip_books'|'touch_sth'|'raise_hand'|'hands_down'|
    'take_notes'|'applaud'|'bend'|'turn_around'|'talk_with_others'|'answer_questions'|'slumped_on_desk';
  label:string;
  state:'unavailable'|'clear'|'pending'|'confirmed';
  source:'MobileViCLIP-Tiny'|'MobileViCLIP-Small'|'SCB-YOLOv7';
  confidence?:number;
  evidenceBox?:Box;
  observedAt:number;
  clipStart?:number;
  similarity?:number;
  margin?:number;
  durationMs?:number;
  reason?:string;
}

export interface StudentTrack extends DetectedPerson {
  displayBoxes?:{box?:Box;person?:Box;face?:Box};
  calibration?:{state:'collecting'|'ready'|'insufficient';headingReady:boolean;postureReady:boolean;startedAt:number;expiresAt:number;reference?:'camera'};
  actionAlert?:{type:ActionObservation['type'];label:string;observedAt:number;expiresAt:number};
  studyContext?: 'book';
  presentation?: { recovering: boolean; opacity: number };
  frameTime?: number;
  signals?: BehaviorSignal[];
  alerts?: BehaviorAlert[];
  analysisAt?: number;
  personId?: number;
  attention?: 'focused' | 'uncertain' | 'needs_attention';
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
}

export interface PersonDetector {
  readonly memory?:MemoryStatus;
  startTracking?(video:HTMLVideoElement|null,image:HTMLImageElement|null,present:(frame:import('./pixel-camera').CameraFrame|null)=>void):Promise<void>;
  stopTracking?():void;
  readonly objects?: TrackedObject[];
  /** Monotonic capture time of the last returned image, including empty results. */
  readonly frameTime?:number;
  detect(video: HTMLVideoElement | null, image?:HTMLImageElement|null): Promise<StudentTrack[]>;
  paintFrame?(target:HTMLCanvasElement):boolean;
  reset?(): void;
  dispose(): void;
}

export const PI_DEVICE = 'raspberry-pi';
export type CameraState = 'off' | 'requesting' | 'on';
export type DetectionState = 'idle' | 'loading' | 'running' | 'paused';
export interface MemoryStatus {totalMB:number;availableMB:number;limit:number;detected:number;processed:number;limited:boolean;pressure:boolean;}

export interface PiStatus {
  online: boolean;
  deviceOnline: boolean;
  state: 'off' | 'waiting_backend' | 'starting' | 'streaming' | 'reconnecting' | 'shutting_down' | 'offline';
  desired: boolean;
  cameraReleased: boolean;
  bootId: string;
  generation: number;
  width: number;
  height: number;
  error: string | null;
}

export interface HealthResponse {
  status: 'ok' | 'loading' | 'error';
  error?: string;
  modelReady: boolean;
  detector?: 'classroom';
  capabilities?: {
    profile?: string;
    maxDetectEdge?: number;
    maxTrackEdge?: number;
    people?: string;
    [key: string]: unknown;
  };
  metrics?: {
    privateMemoryMB?: number;
    [key: string]: unknown;
  };
}
