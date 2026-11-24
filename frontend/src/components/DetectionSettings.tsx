import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {SlidersHorizontal,X,RotateCcw,ChevronDown,ChevronUp} from 'lucide-react';
import {CLASSROOM_PRIORITY_IDS,getRuntimeProfileHints,loadDetectionSettingsSchema,normalizeDetectionSettings,readDetectionSettings,saveDetectionSettings} from '../lib/detection-settings';
import type {DetectionSettingsSchema,DetectionSettings as Settings} from '../lib/detection-settings';

export default function DetectionSettings(){
  const [open,setOpen]=useState(false),[schema,setSchema]=useState<DetectionSettingsSchema|null>(null);
  const [showDetails,setShowDetails]=useState(true);
  const [objectsEnabled,setObjectsEnabled]=useState(false);
  const [enabled,setEnabled]=useState<Settings['enabled']>({}),[values,setValues]=useState<Record<string,string>>({});
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[retry,setRetry]=useState(0);
  const dialog=useRef<HTMLDialogElement>(null);
  const hints=getRuntimeProfileHints();
  const edit=(definition:DetectionSettingsSchema,settings:Settings)=>{
    setObjectsEnabled(Boolean(settings.objectsEnabled));
    setEnabled({...settings.enabled});
    setValues(Object.fromEntries(definition.fields.map(field=>[field.key,String(settings.thresholds[field.key]/field.scale)])));
  };
  const applyPreset=(preset:'lite'|'full')=>{
    if(!schema)return;
    const priority=new Set<string>(CLASSROOM_PRIORITY_IDS);
    const nextObjects=preset==='full';
    setObjectsEnabled(nextObjects);
    setEnabled(Object.fromEntries(schema.behaviors.map(item=>[item.id,preset==='full'||priority.has(item.id)])));
    setMessage(preset==='lite'?'Đã chọn chế độ Ưu tiên lớp học (Nhẹ RAM). Bấm Lưu ngưỡng để áp dụng.':'Đã chọn chế độ Đầy đủ 11 dấu hiệu + Đồ vật. Bấm Lưu ngưỡng để áp dụng.');
    setError('');
  };
  useEffect(()=>{
    if(!open)return;
    dialog.current?.showModal();
    const abort=new AbortController();setSchema(null);setError('');setMessage('');
    void loadDetectionSettingsSchema(abort.signal).then(definition=>{
      if(abort.signal.aborted)return;
      setSchema(definition);edit(definition,normalizeDetectionSettings(definition,readDetectionSettings()));
    }).catch(reason=>{if(!abort.signal.aborted)setError(reason instanceof Error?reason.message:'Không tải được cấu hình.');});
    return ()=>abort.abort();
  },[open,retry]);
  const close=()=>{dialog.current?.close();setOpen(false);};
  const prioritySet=new Set<string>(CLASSROOM_PRIORITY_IDS);
  const isLitePreset=schema?!objectsEnabled&&schema.behaviors.every(b=>Boolean(enabled[b.id])===prioritySet.has(b.id)):false;
  const isFullPreset=schema?objectsEnabled&&schema.behaviors.every(b=>Boolean(enabled[b.id])):false;
  const profileLabel=hints.profile==='lite'?'8GB Nhẹ':hints.profile==='balanced'?'16GB Cân bằng':hints.profile;
  return <>
    <button className="control-button button-outline threshold-toggle" aria-label="Ngưỡng nhận diện" title="Ngưỡng nhận diện"
      onClick={()=>setOpen(true)}><SlidersHorizontal size={16}/></button>
    {open&&createPortal(<dialog ref={dialog} className="detection-settings" aria-labelledby="threshold-title" onCancel={close}>
      <form noValidate onSubmit={event=>{
        event.preventDefault();if(!schema)return;
        const thresholds:Record<string,number>={};
        for(const field of schema.fields){
          const raw=values[field.key]?.trim(),value=raw?Number(raw)*field.scale:NaN;
          if(!Number.isFinite(value)||Math.abs(value-Math.round(value))>1e-6||value<field.min||value>field.max){
            if(!enabled[field.group]){thresholds[field.key]=schema.defaults.thresholds[field.key];continue;}
            setError(`${field.label}: nhập từ ${field.min/field.scale} đến ${field.max/field.scale} ${field.unit}.`);setMessage('');return;
          }
          thresholds[field.key]=Math.round(value);
        }
        try{saveDetectionSettings({objectsEnabled,enabled,thresholds});setError('');setMessage('Đã lưu. Áp dụng từ khung nhận diện tiếp theo.');}
        catch{setMessage('');setError('Trình duyệt không cho lưu cấu hình. Kiểm tra quyền lưu trữ rồi thử lại.');}
      }}>
        <header className="threshold-header"><div><h2 id="threshold-title">Ngưỡng nhận diện</h2><p>Lưu cho trình duyệt này. Tắt các dấu hiệu hoặc đồ vật không cần thiết để giảm tải RAM và CPU.</p></div>
          <button type="button" className="icon-button" aria-label="Đóng ngưỡng nhận diện" onClick={close}><X size={18}/></button></header>
        <div className="threshold-body">
          <div className="threshold-hint">
            <span><span className="threshold-editable" aria-hidden="true">*</span> Có thể chỉnh. Rê chuột lên tên để xem mô tả. Bấm Lưu ngưỡng để áp dụng; giữ mã người và bbox.</span>
            {(profileLabel||hints.privateMemoryMB!==undefined)&&<span className="threshold-profile-badge">
              {profileLabel?`Cấu hình máy: ${profileLabel}`:''}{hints.personModel?` (${hints.personModel})`:''}{hints.privateMemoryMB?` · RAM AI: ~${Math.round(hints.privateMemoryMB)} MB`:''}
            </span>}
          </div>
          {!schema&&!error&&<p role="status">Đang tải ngưỡng từ backend…</p>}
          {!schema&&error&&<button type="button" className="control-button button-outline" onClick={()=>setRetry(value=>value+1)}>Tải lại cấu hình</button>}
          {schema&&<>
            <div className="threshold-presets" role="group" aria-label="Chế độ cấu hình nhanh">
              <button type="button" className={'control-button '+(isLitePreset?'button-blue':'button-outline')} onClick={()=>applyPreset('lite')}>
                Ưu tiên lớp học (Nhẹ RAM)
              </button>
              <button type="button" className={'control-button '+(isFullPreset?'button-blue':'button-outline')} onClick={()=>applyPreset('full')}>
                Đầy đủ 11 dấu hiệu + Đồ vật
              </button>
              <button type="button" className="control-button button-outline threshold-collapse-toggle"
                aria-expanded={showDetails} onClick={()=>setShowDetails(value=>!value)}>
                {showDetails?<ChevronUp size={15}/>:<ChevronDown size={15}/>}
                <span>{showDetails?'Ẩn bảng ngưỡng':'Hiện bảng ngưỡng'}</span>
              </button>
            </div>
            <div className="threshold-object-card">
              <div className="threshold-object-text">
                <strong>Nhận dạng đồ vật (điện thoại, laptop, sách/vở)</strong>
                <p>Tắt để tiết kiệm đáng kể RAM/CPU (ngừng quét đồ vật và bàn tay). <em>Cầm điện thoại</em> và <em>Tương tác laptop</em> cần bật mục này.</p>
              </div>
              <button type="button" role="switch" className="pill-switch" aria-label="Nhận dạng đồ vật" aria-checked={objectsEnabled}
                onClick={()=>{
                  const next=!objectsEnabled;
                  setObjectsEnabled(next);
                  if(!next)setEnabled(prev=>({...prev,phone:false,laptop:false}));
                  setMessage('');setError('');
                }}><span className="switch-thumb"/></button>
            </div>
            {showDetails&&<div className="threshold-list">{schema.behaviors.map(behavior=>{
              const requiresObjects=behavior.requiresObjects||behavior.id==='phone'||behavior.id==='laptop';
              return <div key={behavior.id} className="threshold-row" role="group" aria-label={behavior.label}>
                <label className="threshold-name" title={behavior.description}><input type="checkbox" checked={enabled[behavior.id]??true} aria-label={behavior.label} onChange={event=>{
                  const checked=event.target.checked;
                  if(checked&&requiresObjects&&!objectsEnabled)setObjectsEnabled(true);
                  setEnabled({...enabled,[behavior.id]:checked});setMessage('');setError('');
                }}/><span>{behavior.label}<span className="threshold-editable" aria-hidden="true"> *</span>
                  {requiresObjects&&!objectsEnabled&&<small className="threshold-note">Cần bật Nhận dạng đồ vật</small>}
                </span></label>
                <div className="threshold-fields">{schema.fields.filter(field=>field.group===behavior.id).map(field=><label key={field.key} className="threshold-field">
                  <span>{field.label}<span className="threshold-editable" aria-hidden="true"> *</span></span><span className="threshold-number"><input type="number" aria-label={`${behavior.label} — ${field.label}`}
                    min={field.min/field.scale} max={field.max/field.scale} step={field.step/field.scale} value={values[field.key]??''}
                    disabled={!enabled[behavior.id]} onChange={event=>{setValues({...values,[field.key]:event.target.value});setMessage('');setError('');}}/>
                    <span>{field.unit}</span></span></label>)}</div>
              </div>;
            })}</div>}
          </>}
        </div>
        <footer className="threshold-footer"><div className="threshold-feedback">{error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}</div>
          <div className="threshold-actions"><button type="button" className="control-button button-outline" disabled={!schema} onClick={()=>{
            if(schema)edit(schema,schema.defaults);setMessage('Đã điền ngưỡng mặc định. Bấm Lưu ngưỡng để áp dụng.');setError('');
          }}><RotateCcw size={15}/>Mặc định</button>
          <button type="submit" className="control-button button-blue" disabled={!schema}>Lưu ngưỡng</button></div></footer>
      </form>
    </dialog>,document.body)}
  </>;
}
