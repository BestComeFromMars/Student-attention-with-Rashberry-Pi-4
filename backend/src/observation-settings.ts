import type {BehaviorSignal} from './types.js';
import {HttpError} from './errors.js';

type Kind=BehaviorSignal['type'];
export const BEHAVIOR_SETTINGS: {id:Kind;label:string;description:string;requiresObjects?:boolean}[]=[
  {id:'upper_body_slumped',label:'Gục đầu/thân trên',description:'Dùng pose hoặc bằng chứng gục bàn đối chiếu với người; không khẳng định đang ngủ.'},
  {id:'eyes_closed',label:'Nhắm mắt kéo dài',description:'Tăng thời gian để bỏ qua những lần nhắm mắt ngắn.'},
  {id:'yawn',label:'Có thể ngáp',description:'Cần số đo miệng hợp lệ, không suy ra khi khuất mặt.'},
  {id:'talking',label:'Có thể nói chuyện kéo dài',description:'Phát hiện chuyển động miệng/nhép miệng liên tục theo thời gian; loại dao động nhỏ, quay đầu mạnh, cười/ngáp. Không xác nhận lời nói bằng âm thanh.'},
  {id:'head_turning',label:'Quay đầu qua lại nhiều lần',description:'Đếm lần đổi hướng rõ; dùng ngưỡng góc quay lệch để bỏ qua chuyển động cổ nhẹ.'},
  {id:'head_turned',label:'Quay lệch hướng lâu',description:'Chỉ xét hướng đầu lệch rõ và kéo dài so với camera; bỏ qua quay cổ nhẹ.'},
  {id:'head_down',label:'Cúi đầu',description:'Cúi đọc/viết có sách vở vẫn được xử lý theo ngữ cảnh khi bật nhận dạng đồ vật.'},
  {id:'torso_turned',label:'Quay thân sang bên',description:'Cần hình học thân phù hợp và đầu quay lệch; thiếu pose vẫn là thiếu dữ liệu.'},
  {id:'turned_smiling',label:'Quay sang bên kèm cười',description:'Chỉ xét cười khi quay lệch đã được xác nhận.'},
  {id:'phone',label:'Cầm điện thoại',description:'Cần bật Nhận dạng đồ vật và bằng chứng tương tác với điện thoại.',requiresObjects:true},
  {id:'laptop',label:'Tương tác laptop',description:'Cần bật Nhận dạng đồ vật; phát hiện laptop đơn thuần không phải tương tác đã xác nhận.',requiresObjects:true},
];
export const CLASSROOM_PRIORITY_BEHAVIORS: readonly Kind[]=[
  'upper_body_slumped','eyes_closed','yawn','talking','head_turning','head_turned','head_down',
];
const duration=(group:Kind,value:number)=>({group,label:'Thời gian xác nhận',value,min:100,max:30000,step:100,scale:1000,unit:'giây'});
export const THRESHOLD_DEFINITIONS={
  eyesClosedMs:duration('eyes_closed',800),phoneMs:duration('phone',400),
  headDownMs:duration('head_down',700),
  headDownPitchDeg:{group:'head_down',label:'Góc cúi tối thiểu',value:18,min:5,max:60,step:1,scale:1,unit:'°'},
  yawnMs:duration('yawn',500),talkingMs:duration('talking',1500),
  laptopMs:duration('laptop',700),
  headTurnChanges:{group:'head_turning',label:'Số lần đổi hướng',value:3,min:2,max:10,step:1,scale:1,unit:'lần'},
  headTurnWindowMs:{group:'head_turning',label:'Cửa sổ đếm',value:10000,min:2000,max:60000,step:1000,scale:1000,unit:'giây'},
  headTurnedMs:duration('head_turned',2000),
  headTurnAngleDeg:{group:'head_turned',label:'Góc lệch tối thiểu',value:35,min:10,max:70,step:1,scale:1,unit:'°'},
  torsoTurnedMs:duration('torso_turned',2000),
  torsoNarrowPercent:{group:'torso_turned',label:'Tỷ lệ vai/thân tối đa so với mốc',value:75,min:40,max:95,step:1,scale:1,unit:'%'},
  turnedSmilingMs:duration('turned_smiling',500),
  smilePercent:{group:'turned_smiling',label:'Điểm cười hai bên tối thiểu',value:55,min:10,max:95,step:1,scale:1,unit:'%'},
  slumpMs:duration('upper_body_slumped',1500),
  slumpTiltDeg:{group:'upper_body_slumped',label:'Góc nghiêng thân rõ',value:40,min:20,max:75,step:1,scale:1,unit:'°'},
  slumpHeightPercent:{group:'upper_body_slumped',label:'Chiều cao thân tối đa so với mốc',value:65,min:30,max:90,step:1,scale:1,unit:'%'},
  deskRestConfidencePercent:{group:'upper_body_slumped',label:'Điểm model gục bàn tối thiểu',value:25,min:25,max:90,step:1,scale:1,unit:'%'},
} as const;
export type ThresholdKey=keyof typeof THRESHOLD_DEFINITIONS;
export interface ObservationSettings {objectsEnabled:boolean;enabled:Record<Kind,boolean>;thresholds:Record<ThresholdKey,number>;}
export interface ActiveAIFeatures {
  objects: boolean;
  hands: boolean;
  faceMesh: boolean;
  profileMesh: boolean;
  pose: boolean;
  deskRest: boolean;
  faceHeading: boolean;
}
export function activeFeaturesForSettings(settings:ObservationSettings):ActiveAIFeatures {
  const e=settings.enabled;
  const objects=Boolean(settings.objectsEnabled);
  return {
    objects,
    hands: objects && (e.phone || e.laptop || e.head_down),
    faceMesh: e.eyes_closed || e.yawn || e.talking || e.turned_smiling || e.head_down,
    profileMesh: e.talking || e.yawn || e.head_turned || e.head_turning,
    pose: e.upper_body_slumped || e.torso_turned || e.head_turned || e.head_turning,
    deskRest: e.upper_body_slumped,
    faceHeading: e.head_turned || e.head_turning,
  };
}
export function defaultObservationSettings():ObservationSettings {
  const priority=new Set<Kind>(CLASSROOM_PRIORITY_BEHAVIORS);
  return {objectsEnabled:false,
    enabled:Object.fromEntries(BEHAVIOR_SETTINGS.map(item=>[item.id,priority.has(item.id)])) as Record<Kind,boolean>,
    thresholds:Object.fromEntries(Object.entries(THRESHOLD_DEFINITIONS).map(([key,item])=>[key,item.value])) as ObservationSettings['thresholds']};
}
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
/** A complete, bounded per-session configuration; never silently accept unknown knobs. */
export function parseObservationSettings(value:unknown):ObservationSettings {
  const invalid=()=>{throw new HttpError(400,'Cấu hình ngưỡng không hợp lệ. Kiểm tra giá trị hoặc khôi phục mặc định.');};
  if(!record(value)||Object.keys(value).some(key=>!['objectsEnabled','enabled','thresholds'].includes(key))||!record(value.enabled)||!record(value.thresholds))return invalid();
  if(value.objectsEnabled!==undefined&&typeof value.objectsEnabled!=='boolean')return invalid();
  const defaults=defaultObservationSettings();
  if(value.objectsEnabled!==undefined)defaults.objectsEnabled=value.objectsEnabled;
  if(Object.keys(value.enabled).length!==BEHAVIOR_SETTINGS.length||Object.keys(value.thresholds).length!==Object.keys(THRESHOLD_DEFINITIONS).length)return invalid();
  for(const {id} of BEHAVIOR_SETTINGS){if(typeof value.enabled[id]!=='boolean')return invalid();defaults.enabled[id]=value.enabled[id];}
  for(const key of Object.keys(THRESHOLD_DEFINITIONS) as ThresholdKey[]){
    const field=THRESHOLD_DEFINITIONS[key],number=value.thresholds[key];
    if(typeof number!=='number'||!Number.isFinite(number)||!Number.isInteger(number)||number<field.min||number>field.max)return invalid();
    defaults.thresholds[key]=number;
  }
  return defaults;
}
export const observationSettingsSchema=()=>({defaults:defaultObservationSettings(),behaviors:BEHAVIOR_SETTINGS,
  fields:Object.entries(THRESHOLD_DEFINITIONS).map(([key,value])=>({key,...value}))});
