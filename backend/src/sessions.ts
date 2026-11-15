import { randomUUID } from 'node:crypto';
import { StudentTracker } from './tracker.js';
import { HttpError } from './errors.js';
import { AttentionEvaluator } from './attention.js';
import type { InferenceEngine, TrackedObject,MemoryStatus } from './types.js';
import {defaultObservationSettings,parseObservationSettings,type ObservationSettings} from './observation-settings.js';
import {BoxPresentation} from './box-presentation.js';

interface Session { tracker: StudentTracker; attention: AttentionEvaluator; objects: TrackedObject[]; lastUsed: number; busy: boolean;
  source?:'upload'|'pi';engineId:string;settings:ObservationSettings;presentation:BoxPresentation;memory?:MemoryStatus; }
export class Sessions {
  private sessions = new Map<string, Session>();
  constructor(private readonly now:()=>number=()=>Date.now()) {}
  create(configuration?:unknown) {
    const settings=configuration===undefined?defaultObservationSettings():parseObservationSettings(configuration);
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (!session.busy && now - session.lastUsed > 30 * 60 * 1000) this.sessions.delete(id);
    }
    if (this.sessions.size >= 100) throw new HttpError(429, 'Đã đạt giới hạn phiên. Đóng các phiên cũ rồi thử lại.');
    const id = randomUUID();
    this.sessions.set(id, { tracker: new StudentTracker(), attention: new AttentionEvaluator(settings), objects:[], lastUsed: now, busy: false,engineId:id,settings,presentation:new BoxPresentation() });
    return id;
  }
  delete(id: string,engine?:InferenceEngine) {
    const session=this.sessions.get(id);
    this.sessions.delete(id);
    if(session)engine?.release?.(session.engineId);
  }
  objects(id: string) { return this.sessions.get(id)?.objects ?? []; }
  memory(id:string){return this.sessions.get(id)?.memory;}
  settings(id:string){
    const session=this.sessions.get(id);
    if(!session)throw new HttpError(404,'Phiên đã kết thúc. Bắt đầu lại nhận diện.');
    return parseObservationSettings(session.settings);
  }
  configure(id:string,configuration:unknown){
    const settings=parseObservationSettings(configuration),session=this.sessions.get(id);
    if(!session)throw new HttpError(404,'Phiên đã kết thúc. Bắt đầu lại nhận diện.');
    if(session.busy)throw new HttpError(409,'Đợi khung hình hiện tại hoàn tất rồi đổi ngưỡng.');
    if(JSON.stringify(settings)!==JSON.stringify(session.settings)){
      session.settings=settings;session.attention=new AttentionEvaluator(settings);session.tracker.retainAlerts([]);
    }
    session.lastUsed=this.now();return this.settings(id);
  }
  async track(id:string,jpeg:Buffer,engine:InferenceEngine,frameId:number,capturedAt?:number){
    const session=this.sessions.get(id);
    if(!session)throw new HttpError(404,'Phiên đã kết thúc.');
    if(!engine.trackFrame)throw new HttpError(503,'Backend chưa hỗ trợ luồng bám hình ảnh.');
    session.lastUsed=this.now();
    return engine.trackFrame(jpeg,{sessionId:session.engineId,frameId,capturedAt});
  }
  async detect(id: string, jpeg: Buffer, engine: InferenceEngine,source:'upload'|'pi'='upload',frameId?:number) {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError(404, 'Phiên đã kết thúc. Bắt đầu lại nhận diện.');
    if (session.busy) throw new HttpError(409, 'Phiên đang xử lý một khung hình khác.');
    if(session.source&&session.source!==source){
      engine.release?.(session.engineId);session.engineId=randomUUID();
      session.tracker=new StudentTracker();session.attention=new AttentionEvaluator(session.settings);session.objects=[];
      session.presentation=new BoxPresentation();
    }
    session.source=source;
    session.busy = true;
    session.lastUsed = this.now();
    try {
      const result = engine.detectFrame ? await engine.detectFrame(jpeg,{sessionId:session.engineId,frameId})
        : {people:await engine.detect(jpeg,{sessionId:session.engineId}),objects:undefined,frameAt:undefined,memory:undefined};
      if (this.sessions.get(id) !== session) throw new HttpError(410, 'Kết quả thuộc phiên đã kết thúc.');
      session.lastUsed = this.now();
      session.memory=result.memory;
      const tracks = session.attention.evaluate(session.tracker.update(result.people, session.lastUsed), session.lastUsed);
      const objects = result.objects ?? tracks.flatMap(track=>(track.objects??[]).map((object,index)=>({...object,
        id:`${track.id}-${object.kind}-${index}`,trackedAt:object.observedAt,trackingState:'detected' as const,ownerGeometryId:track.geometryId,ownerPersonId:track.personId,ownerId:track.id})));
      session.objects=objects.filter(object=>Number.isFinite(object.trackedAt)&&
        (result.frameAt!==undefined?object.trackedAt===result.frameAt:
          session.lastUsed-object.trackedAt<=(result.objects===undefined?5000:1000)&&object.trackedAt<=session.lastUsed+1000))
        .map(object=>({...object,ownerId:object.ownerPersonId!=null?tracks.find(track=>track.personId===object.ownerPersonId)?.id:
          object.ownerGeometryId==null ? object.ownerId:tracks.find(track=>track.geometryId===object.ownerGeometryId)?.id}));
      session.tracker.retainAlerts(tracks);
      if(frameId!==undefined){
        const seeds:import('./pixel-tracker.js').PixelSeed[]=[];
        for(const track of tracks.filter(t=>t.status==='visible')){
          if(track.personBox&&track.geometryFrameIds?.person!==undefined)seeds.push({key:'person:'+track.id,box:track.personBox,frameId:track.geometryFrameIds.person});
          if(track.faceBox&&track.faceVisibility!=='unavailable'&&track.geometryFrameIds?.face!==undefined)seeds.push({key:'face:'+track.id,box:track.faceBox,frameId:track.geometryFrameIds.face});
        }
        for(const object of session.objects)seeds.push({key:'object:'+object.id,box:object.box,frameId});
        engine.seedGeometry?.(session.engineId,seeds);
      }
      const displayed=session.presentation.update(tracks,session.objects,result.frameAt??session.lastUsed);
      session.objects=displayed.objects;return displayed.tracks;
    } finally { session.busy = false; }
  }
}
