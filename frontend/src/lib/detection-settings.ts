import type {BehaviorSignal} from './types';

export const DETECTION_SETTINGS_KEY='student-attention.observation-settings.v4';
export const DETECTION_SETTINGS_EVENT='student-attention:settings';
const V3_SETTINGS_KEY='student-attention.observation-settings.v3';
const PREVIOUS_SETTINGS_KEY='student-attention.observation-settings.v2';
const LEGACY_SETTINGS_KEY='student-attention.observation-settings.v1';
export const CLASSROOM_PRIORITY_IDS: readonly BehaviorSignal['type'][]=[
  'upper_body_slumped','eyes_closed','yawn','talking','head_turning','head_turned','head_down',
];
export interface DetectionSettings {objectsEnabled?:boolean;enabled:Record<string,boolean>;thresholds:Record<string,number>;}
export interface ThresholdField {key:string;group:BehaviorSignal['type'];label:string;value:number;min:number;max:number;step:number;scale:number;unit:string;}
export interface DetectionSettingsSchema {defaults:DetectionSettings;behaviors:{id:BehaviorSignal['type'];label:string;description:string;requiresObjects?:boolean}[];fields:ThresholdField[];}
export interface RuntimeProfileHints {profile?:string;maxDetectEdge?:number;maxTrackEdge?:number;personModel?:string;privateMemoryMB?:number;}
let runtimeHints:RuntimeProfileHints={};
export function getRuntimeProfileHints():RuntimeProfileHints{return runtimeHints;}
export function setRuntimeProfileHints(hints:RuntimeProfileHints){runtimeHints={...hints};}
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
export function readDetectionSettings():DetectionSettings|null {
  try{
    const current=localStorage.getItem(DETECTION_SETTINGS_KEY);
    const v3=current===null?localStorage.getItem(V3_SETTINGS_KEY):null;
    const previous=current===null&&v3===null?localStorage.getItem(PREVIOUS_SETTINGS_KEY):null;
    const value:unknown=JSON.parse(current??v3??previous??localStorage.getItem(LEGACY_SETTINGS_KEY)??'null');
    if(!record(value)||!record(value.enabled)||!record(value.thresholds)||
      (value.objectsEnabled!==undefined&&typeof value.objectsEnabled!=='boolean')||
      !Object.values(value.enabled).every(v=>typeof v==='boolean')||
      !Object.values(value.thresholds).every(v=>typeof v==='number'&&Number.isFinite(v)))return null;
    const settings=value as unknown as DetectionSettings;
    if(current===null){
      // Upgrade older defaults once; retain custom thresholds.
      if(v3===null&&previous===null&&settings.thresholds.headTurnAngleDeg===25)settings.thresholds.headTurnAngleDeg=35;
      if(v3!==null){
        settings.objectsEnabled=false;
        settings.enabled.phone=false;
        settings.enabled.laptop=false;
      }else{
        settings.enabled.phone=false;
      }
      try{localStorage.setItem(DETECTION_SETTINGS_KEY,JSON.stringify(settings));}catch{/* Use the migrated settings in memory. */}
    }
    return settings;
  }catch{return null;}
}
export function saveDetectionSettings(settings:DetectionSettings){
  localStorage.setItem(DETECTION_SETTINGS_KEY,JSON.stringify(settings));
  window.dispatchEvent(new Event(DETECTION_SETTINGS_EVENT));
}
export function normalizeDetectionSettings(schema:DetectionSettingsSchema,stored:DetectionSettings|null):DetectionSettings {
  const hasObjects='objectsEnabled' in schema.defaults||typeof stored?.objectsEnabled==='boolean';
  const objectsEnabled=stored?.objectsEnabled??schema.defaults.objectsEnabled??false;
  return {
    ...(hasObjects?{objectsEnabled}:{}),
    enabled:Object.fromEntries(schema.behaviors.map(({id})=>[id,stored?.enabled[id]??schema.defaults.enabled[id]])),
    thresholds:Object.fromEntries(schema.fields.map(field=>{
      const value=stored?.thresholds[field.key];
      return [field.key,typeof value==='number'&&Number.isInteger(value)&&value>=field.min&&value<=field.max?value:schema.defaults.thresholds[field.key]];
    }))};
}
export async function loadDetectionSettingsSchema(signal?:AbortSignal):Promise<DetectionSettingsSchema>{
  const response=await fetch('/api/observation-settings',{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('Không tải được ngưỡng nhận diện từ backend. Thử lại khi kết nối sẵn sàng.');
  const value=await response.json();
  if(!record(value)||!Array.isArray(value.behaviors)||!Array.isArray(value.fields)||!record(value.defaults)||
    !record(value.defaults.enabled)||!record(value.defaults.thresholds)||!value.behaviors.length||value.behaviors.length>50||value.fields.length>100||
    (value.defaults.objectsEnabled!==undefined&&typeof value.defaults.objectsEnabled!=='boolean')||
    !value.behaviors.every(item=>record(item)&&typeof item.id==='string'&&typeof item.label==='string'&&typeof item.description==='string')||
    !value.fields.every(field=>record(field)&&typeof field.key==='string'&&typeof field.group==='string'&&typeof field.label==='string'&&
      typeof field.unit==='string'&&[field.min,field.max,field.step,field.scale,field.value].every(n=>typeof n==='number'&&Number.isFinite(n))&&
      Number(field.scale)>0&&Number(field.step)>0&&Number(field.min)<=Number(field.max)))throw new Error('Dữ liệu ngưỡng nhận diện không hợp lệ.');
  const schema=value as unknown as DetectionSettingsSchema;
  if(new Set(schema.behaviors.map(item=>item.id)).size!==schema.behaviors.length||new Set(schema.fields.map(field=>field.key)).size!==schema.fields.length||
    !schema.behaviors.every(item=>typeof schema.defaults.enabled[item.id]==='boolean')||
    !schema.fields.every(field=>schema.behaviors.some(item=>item.id===field.group)&&Number.isInteger(schema.defaults.thresholds[field.key])&&
      schema.defaults.thresholds[field.key]>=field.min&&schema.defaults.thresholds[field.key]<=field.max))throw new Error('Dữ liệu ngưỡng nhận diện không hợp lệ.');
  return schema;
}
