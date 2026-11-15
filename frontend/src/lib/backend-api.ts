import { PI_DEVICE } from './types';
import type { PersonDetector, StudentTrack, TrackedObject,MemoryStatus } from './types';
import { FrameEncoder } from './frame-encoder';
import {PixelCamera} from './pixel-camera';
import {readDetectionSettings,loadDetectionSettingsSchema,normalizeDetectionSettings,type DetectionSettingsSchema} from './detection-settings';

function invalidPayload(): never {
  throw Object.assign(new Error('Dữ liệu nhận diện từ backend không hợp lệ. Thử kết nối lại.'), { status: 502 });
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validDisplayBox(value:unknown){
  if(!record(value))return false;
  const {x,y,width,height}=value;
  return [x,y,width,height].every(n=>typeof n==='number'&&Number.isFinite(n))&&
    Number(x)>=0&&Number(y)>=0&&Number(width)>0&&Number(height)>0&&Number(x)+Number(width)<=1.000001&&Number(y)+Number(height)<=1.000001;
}
function validTrack(value: unknown): value is StudentTrack {
  if (!record(value) || typeof value.id !== 'string' || !value.id || !record(value.box)) return false;
  const { x, y, width, height } = value.box;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number' ||
    ![x, y, width, height].every(Number.isFinite)) return false;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) return false;
  if (value.studyContext !== undefined && value.studyContext !== 'book') return false;
  if(value.displayBoxes!==undefined&&(!record(value.displayBoxes)||Object.entries(value.displayBoxes).some(([key,box])=>
    !['box','person','face'].includes(key)||box!==undefined&&!validDisplayBox(box))))return false;
  if(value.calibration!==undefined&&(!record(value.calibration)||
    !['collecting','ready','insufficient'].includes(String(value.calibration.state))||
    typeof value.calibration.headingReady!=='boolean'||typeof value.calibration.postureReady!=='boolean'||
    ![value.calibration.startedAt,value.calibration.expiresAt].every(n=>typeof n==='number'&&Number.isFinite(n))))return false;
  if (value.objects !== undefined && (!Array.isArray(value.objects) || value.objects.length > 100 || !value.objects.every(object => {
    if (!record(object) || !['phone','book','laptop'].includes(String(object.kind)) || !record(object.box)) return false;
    if (object.interaction !== undefined && typeof object.interaction !== 'boolean') return false;
    if (object.delayed !== undefined && typeof object.delayed !== 'boolean') return false;
    const { x, y, width, height } = object.box;
    return [x,y,width,height,object.confidence,object.observedAt].every(number => typeof number === 'number' && Number.isFinite(number)) &&
      (x as number) >= 0 && (y as number) >= 0 && (width as number) > 0 && (height as number) > 0 &&
      (x as number)+(width as number) <= 1.000001 && (y as number)+(height as number) <= 1.000001 &&
      (object.confidence as number) >= 0 && (object.confidence as number) <= 1;
  }))) return false;
  if (value.signals !== undefined && (!Array.isArray(value.signals) || !value.signals.every(signal =>
    record(signal) && typeof signal.label === 'string' && ['unavailable', 'clear', 'pending', 'confirmed'].includes(String(signal.state))))) return false;
  if (value.alerts !== undefined && (!Array.isArray(value.alerts) || !value.alerts.every(alert =>
    record(alert) && typeof alert.label === 'string' && typeof alert.held === 'boolean' &&
    ['eyes_closed', 'phone', 'head_down', 'yawn', 'talking', 'laptop', 'head_turning',
      'head_turned','torso_turned','turned_smiling','upper_body_slumped'].includes(String(alert.type)) &&
    typeof alert.observedAt === 'number' && Number.isFinite(alert.observedAt) &&
    typeof alert.expiresAt === 'number' && Number.isFinite(alert.expiresAt)))) return false;
  return typeof value.displayName === 'string' && ['visible', 'lost'].includes(String(value.status));
}

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = record(data) && typeof data.error === 'string' ? data.error : 'Backend không phản hồi (' + response.status + ').';
    throw Object.assign(new Error(message), { status: response.status });
  }
  return response.json().catch(() => invalidPayload()) as Promise<T>;
}

export async function createDetector(source = ''): Promise<PersonDetector> {
  const abort = new AbortController();
  // Prefer the worker encoder so a busy UI does not delay JPEG encoding.
  let encoder:FrameEncoder|null=null;
  let bitmap:ImageBitmap|null=null;
  let pixels:PixelCamera|null=null;
  let pixelSequence=0;
  let captureVersion=0;
  const capture=(source:CanvasImageSource,width:number,height:number)=>{
    const at=performance.now(),version=captureVersion;
    return encoder!.encode(source,width,height).then(frame=>{
      if(closed || version!==captureVersion){frame.bitmap.close();throw new Error('Camera capture cancelled');}
      return {...frame,at};
    });
  };
  const invalidateCapture=()=>{
    captureVersion++;
  };
  const canvas = typeof OffscreenCanvas!=='undefined'
    ? new OffscreenCanvas(1,1) : document.createElement('canvas');
  let frameAvailable=false;
  let currentFrameTime:number|undefined;
  let previousTracks:StudentTrack[]=[];
  let currentObjects:TrackedObject[]=[];
  let currentMemory:MemoryStatus|undefined;
  let closed = false;
  let settingsSchema:DetectionSettingsSchema|null=null;
  const schema=async()=>settingsSchema??(settingsSchema=await loadDetectionSettingsSchema(abort.signal));
  const createSession = () => {
    const stored=readDetectionSettings(),configuration=JSON.stringify(stored);
    const promise = (async()=>{
      const settings=stored?normalizeDetectionSettings(await schema(),stored):null;
      return fetch('/api/sessions', { method: 'POST', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
        ...(settings?{headers:{'Content-Type':'application/json'},body:JSON.stringify({settings})}:{}) });
    })()
      .then(response => readResponse<unknown>(response))
      .then(data => record(data) && typeof data.sessionId === 'string' && data.sessionId ? {id:data.sessionId,configuration} : invalidPayload());
    void promise.catch(() => {});
    return promise;
  };
  const remove = (session: Promise<{id:string;configuration:string}>) => {
    void session.then(({id}) => fetch('/api/sessions/' + id, { method: 'DELETE', keepalive: true })).catch(() => {});
  };
  let session = createSession();
  await session;
  if(typeof Worker!=='undefined' && typeof OffscreenCanvas!=='undefined' && typeof createImageBitmap==='function'){
    try{encoder=new FrameEncoder();}catch{/* unsupported worker/CSP: use canvas */}
  }
  return {
    async startTracking(video,image,present){
      pixels?.stop();pixels=new PixelCamera(async()=>'/api/sessions/'+(await session).id,source===PI_DEVICE?null:video,source===PI_DEVICE?image:null,present,()=>++pixelSequence);
      await pixels.start();
    },
    stopTracking(){pixels?.stop();pixels=null;},
    get objects(){return currentObjects;},
    get memory(){return currentMemory;},
    get frameTime(){return currentFrameTime;},
    async detect(video,imageSource) {
      const context = await session,id=context.id;
      if (closed) throw new Error('Phiên đã đóng.');
      const stored=readDetectionSettings(),configuration=JSON.stringify(stored);
      if(configuration!==context.configuration){
        const settings=normalizeDetectionSettings(await schema(),stored);
        await readResponse(await fetch('/api/sessions/'+id+'/settings',{method:'PUT',
          headers:{'Content-Type':'application/json'},body:JSON.stringify(settings),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])}));
        context.configuration=configuration;
      }
      let image: Blob | undefined;
      let geometryFrameId:number|undefined;
      let frameTime = performance.now();
      frameAvailable=false;
      currentObjects=[];
      const displayed=source===PI_DEVICE?imageSource:video;
      const width=displayed instanceof HTMLImageElement?displayed.naturalWidth:video?.videoWidth;
      const height=displayed instanceof HTMLImageElement?displayed.naturalHeight:video?.videoHeight;
      if (source !== PI_DEVICE || displayed) {
        if (!displayed || !width || !height) throw new Error('Camera chưa có khung hình.');
        const requested=Number(import.meta.env.VITE_CAMERA_WIDTH||1920);
        const configuredEdge=Number.isFinite(requested)?Math.max(1280,Math.min(3840,requested)):1920;
        // A few large faces retain ample detail at 720p. Avoid encoding and
        // decoding a full 1080p frame for every tracking update. Small/crowded
        // faces keep the configured resolution, including while searching.
        const fewLarge=previousTracks.length>0 && previousTracks.length<=4 &&
          previousTracks.every(track=>{
            // A large torso is not a large face. Recover full source detail
            // immediately on a small/missing face, even if its body is tracked.
            const face=track.faceBox??(!track.personBox&&track.boxKind!=='person'?track.box:undefined);
            return track.status==='visible'&&track.faceVisibility!=='unavailable'&&face!==undefined&&face.width*1280>=100;
          });
        const maxEdge=fewLarge?Math.min(configuredEdge,1280):configuredEdge;
        const scale = Math.min(1, maxEdge / Math.max(width,height));
        const captureWidth=Math.max(1,Math.round(width*scale)),captureHeight=Math.max(1,Math.round(height*scale));
        if(canvas.width!==captureWidth)canvas.width=captureWidth;
        if(canvas.height!==captureHeight)canvas.height=captureHeight;
        bitmap?.close();bitmap=null;
        const snapshot=pixels?await pixels.snapshot():null;
        geometryFrameId=snapshot?.id;
        try{
        if(encoder){
          try{
            // Capture AFTER the previous response, not at the start of its
            // inference: a prefetched image was already one inference old.
            const encoded=await capture(snapshot?.image??displayed,captureWidth,captureHeight);
            bitmap=encoded.bitmap;image=encoded.image;
            frameTime=snapshot?.at??encoded.at;
          }catch(error){
            encoder?.dispose();encoder=null;
            invalidateCapture();
            if(closed)throw error;
          }
        }
        if(!image){
          const context = canvas.getContext('2d') as CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D|null;
          if (!context) throw new Error('Trình duyệt không thể chụp khung hình.');
          context.drawImage(snapshot?.image??displayed, 0, 0, canvas.width, canvas.height);
          frameTime=snapshot?.at??frameTime;
          image = 'convertToBlob' in canvas
            ? await canvas.convertToBlob({type:'image/jpeg',quality:.84})
            : await new Promise<Blob>((resolve, reject) =>
              canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Không thể chụp ảnh camera.')), 'image/jpeg', 0.84));
        }
        }finally{snapshot?.image.close();}
      }
      const responsePromise = fetch('/api/sessions/' + id + '/detect' + (source === PI_DEVICE && !image ? '/pi' : ''), {
        method: 'POST', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90000)]),
        ...(image ? { body: image, headers: { 'Content-Type': 'image/jpeg',...(geometryFrameId===undefined?{}:{'X-Frame-Id':String(geometryFrameId)}) } } : {}),
      });
      const response=await responsePromise;
      const data = await readResponse<unknown>(response);
      if (!record(data) || !Array.isArray(data.tracks) || !data.tracks.every(validTrack) ||
        new Set(data.tracks.map(track => track.id)).size !== data.tracks.length) invalidPayload();
      if(data.memory!==undefined){
        const memory=data.memory;
        if(!record(memory)||!['totalMB','availableMB','limit','detected','processed'].every(key=>Number.isSafeInteger(memory[key])&&Number(memory[key])>=0)||
          Number(memory.limit)<1||Number(memory.limit)>40||Number(memory.processed)>Number(memory.limit)||
          typeof memory.limited!=='boolean'||typeof memory.pressure!=='boolean')invalidPayload();
      }
      currentMemory=data.memory as MemoryStatus|undefined;
      if(data.objects!==undefined && (!Array.isArray(data.objects)||!data.objects.every(object=>
        record(object)&&typeof object.id==='string'&&object.id.length>0&&
        (object.displayBox===undefined||validDisplayBox(object.displayBox))&&
        ['detected','visual'].includes(String(object.trackingState))&&typeof object.trackedAt==='number'&&Number.isFinite(object.trackedAt)&&
        (object.ownerId===undefined||typeof object.ownerId==='string')&&
        validTrack({id:'object-validation',displayName:'',status:'visible',box:object.box,objects:[object]}))||
        new Set(data.objects.map(object=>object.id)).size!==data.objects.length)) invalidPayload();
      const received=performance.now();
      frameAvailable=!!image;
      const measuredAt=source===PI_DEVICE && !image && typeof data.frameAgeMs==='number' && Number.isFinite(data.frameAgeMs) && data.frameAgeMs>=0
        ? received-Math.min(5000,data.frameAgeMs) : frameTime;
      currentFrameTime=measuredAt;
      previousTracks=data.tracks;
      currentObjects=(data.objects as TrackedObject[]|undefined)??data.tracks.flatMap(track=>(track.objects??[]).map((object,index)=>({...object,
        id:`${track.id}-${object.kind}-${index}`,trackedAt:object.observedAt,trackingState:'detected' as const,ownerId:track.id})));
      return data.tracks.map(track => ({ ...track, frameTime:measuredAt }));
    },
    paintFrame(target) {
      if(!frameAvailable || closed)return false;
      const context=target.getContext('2d');
      if(!context)return false;
      const width=bitmap?.width??canvas.width,height=bitmap?.height??canvas.height;
      if(target.width!==width || target.height!==height){target.width=width;target.height=height;}
      context.drawImage(bitmap??canvas,0,0);
      return true;
    },
    reset() {
      currentMemory=undefined;
      if (closed) return;
      const previous = session;
      pixels?.stop();pixels=null;
      invalidateCapture();
      previousTracks=[];
      currentObjects=[];
      currentFrameTime=undefined;frameAvailable=false;
      session = createSession();
      remove(previous);
    },
    dispose() {
      if (closed) return;
      closed = true;
      pixels?.stop();pixels=null;
      invalidateCapture();
      encoder?.dispose();encoder=null;
      bitmap?.close();bitmap=null;
      previousTracks=[];
      currentObjects=[];
      currentFrameTime=undefined;
      frameAvailable=false;
      remove(session);
      abort.abort();
      canvas.width = canvas.height = 0;
    },
  };
}
