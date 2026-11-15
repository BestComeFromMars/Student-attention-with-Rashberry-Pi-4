import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {SlidersHorizontal,X,RotateCcw} from 'lucide-react';
import {loadDetectionSettingsSchema,normalizeDetectionSettings,readDetectionSettings,saveDetectionSettings} from '../lib/detection-settings';
import type {DetectionSettingsSchema,DetectionSettings as Settings} from '../lib/detection-settings';

export default function DetectionSettings(){
  const [open,setOpen]=useState(false),[schema,setSchema]=useState<DetectionSettingsSchema|null>(null);
  const [enabled,setEnabled]=useState<Settings['enabled']>({}),[values,setValues]=useState<Record<string,string>>({});
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[retry,setRetry]=useState(0);
  const dialog=useRef<HTMLDialogElement>(null);
  const edit=(definition:DetectionSettingsSchema,settings:Settings)=>{
    setEnabled({...settings.enabled});setValues(Object.fromEntries(definition.fields.map(field=>[field.key,String(settings.thresholds[field.key]/field.scale)])));
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
  return <>
    <button className="control-button button-outline threshold-toggle" aria-label="Ngưỡng nhận diện" title="Tùy chỉnh ngưỡng nhận diện"
      onClick={()=>setOpen(true)}><SlidersHorizontal size={16}/><span className="desktop-label">Ngưỡng nhận diện</span><span className="mobile-label" aria-hidden="true">Ngưỡng</span></button>
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
        try{saveDetectionSettings({enabled,thresholds});setError('');setMessage('Đã lưu. Áp dụng từ khung nhận diện tiếp theo.');}
        catch{setMessage('');setError('Trình duyệt không cho lưu cấu hình. Kiểm tra quyền lưu trữ rồi thử lại.');}
      }}>
        <header className="threshold-header"><div><h2 id="threshold-title">Ngưỡng nhận diện</h2><p>Chỉnh riêng từng dấu hiệu; lưu cho trình duyệt này, áp dụng cho webcam và Raspberry Pi.</p></div>
          <button type="button" className="icon-button" aria-label="Đóng ngưỡng nhận diện" onClick={close}><X size={18}/></button></header>
        <div className="threshold-body">
          <p className="threshold-hint"><span className="threshold-editable" aria-hidden="true">*</span> Có thể chỉnh. Rê chuột lên tên để xem mô tả. Bấm Lưu ngưỡng để áp dụng; giữ mã người và bbox.</p>
          {!schema&&!error&&<p role="status">Đang tải ngưỡng từ backend…</p>}
          {!schema&&error&&<button type="button" className="control-button button-outline" onClick={()=>setRetry(value=>value+1)}>Tải lại cấu hình</button>}
          {schema&&<div className="threshold-list">{schema.behaviors.map(behavior=><div key={behavior.id} className="threshold-row" role="group" aria-label={behavior.label}>
            <label className="threshold-name" title={behavior.description}><input type="checkbox" checked={enabled[behavior.id]??true} aria-label={behavior.label} onChange={event=>{
              setEnabled({...enabled,[behavior.id]:event.target.checked});setMessage('');setError('');
            }}/><span>{behavior.label}<span className="threshold-editable" aria-hidden="true"> *</span></span></label>
            <div className="threshold-fields">{schema.fields.filter(field=>field.group===behavior.id).map(field=><label key={field.key} className="threshold-field">
              <span>{field.label}<span className="threshold-editable" aria-hidden="true"> *</span></span><span className="threshold-number"><input type="number" aria-label={`${behavior.label} — ${field.label}`}
                min={field.min/field.scale} max={field.max/field.scale} step={field.step/field.scale} value={values[field.key]??''}
                disabled={!enabled[behavior.id]} onChange={event=>{setValues({...values,[field.key]:event.target.value});setMessage('');setError('');}}/>
                <span>{field.unit}</span></span></label>)}</div>
          </div>)}</div>}
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
