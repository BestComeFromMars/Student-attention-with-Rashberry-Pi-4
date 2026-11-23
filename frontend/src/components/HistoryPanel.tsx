import {useEffect,useState,useSyncExternalStore} from 'react';
import {CalendarDays,ChevronDown,RotateCcw,ScanFace,Trash2,Pencil,LoaderCircle} from 'lucide-react';
import type {ObservationSession,SessionSnapshot} from '../lib/session';
import type {DetectionHistory,HistoryCapture} from '../lib/history';

const time=(at:number)=>new Intl.DateTimeFormat('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(at);
const dayLabel=(date:string)=>date.split('-').reverse().join('/');
export default function HistoryPanel({state,session,history,inert=false}:{state:SessionSnapshot;session:ObservationSession;history:DetectionHistory;inert?:boolean}){
  const saved=useSyncExternalStore(history.subscribe,history.getSnapshot);
  const [editing,setEditing]=useState<string>();
  useEffect(()=>{void history.load();},[history]);
  const active=saved.selectedId===saved.activeId?new Set(state.tracks.filter(t=>t.status==='visible'&&t.attention==='needs_attention').map(t=>t.id)):new Set<string>();
  const editable=(capture:HistoryCapture)=>saved.selectedId===saved.activeId&&(state.captures??[]).some(c=>c.captureId===capture.captureId);
  const captures=saved.detail?.captures??[];
  const dayActive=saved.runs.some(r=>r.id===saved.activeId);
  return <section className="attention-panel" aria-label="Danh sách cần chú ý" inert={inert}>
    <div className="history-date"><label><CalendarDays size={16}/><span>Ngày</span>
      <input type="date" aria-label="Ngày lịch sử" value={saved.date} list="history-saved-days" onChange={e=>{if(e.target.value)void history.load(e.target.value);}}/>
      <datalist id="history-saved-days">{saved.days.map(day=><option key={day} value={day}/>)}</datalist></label>
      <span className="sr-only">{saved.runs.length} lần nhận diện</span>
      <div className="attention-actions"><button className="icon-button" aria-label="Xóa lịch sử ngày đang xem" title={dayActive?'Kết thúc lần đang ghi trước khi xóa ngày':'Xóa lịch sử ngày đang xem'}
        disabled={dayActive||!saved.runs.length} onClick={()=>{if(window.confirm(`Xóa toàn bộ lịch sử ngày ${dayLabel(saved.date)} và ảnh đã lưu?`))void history.removeDay(saved.date);}}><Trash2 size={16}/></button>
        <button className="icon-button" aria-label="Đặt lại phiên nhận diện" title="Kết thúc lần hiện tại và bắt đầu lần mới"
          disabled={!saved.activeId&&state.detection!=='running'} onClick={()=>session.reset()}><RotateCcw size={16}/></button></div>
    </div>
    <div className="history-body">
      {saved.error&&<p className="history-error" role="status">{saved.error} <button onClick={()=>void history.load(saved.date)}>Thử lại</button></p>}
      {saved.loading&&!saved.runs.length?<div className="history-loading"><LoaderCircle size={18} className="spin"/>Đang tải lịch sử…</div>:
        !saved.runs.length&&!saved.error?<div className="attention-empty"><span><ScanFace size={32} strokeWidth={1.5}/></span>
          <h3>Chưa có lần nhận diện</h3><p>Bấm Bắt đầu nhận diện để tạo lịch sử cho ngày này.</p></div>:null}
      {saved.runs.map(run=><section className="history-run" key={run.id} data-history-run={run.id}>
        <div className="history-run-heading"><button className="history-run-toggle" aria-expanded={saved.selectedId===run.id} onClick={()=>history.toggle(run.id)}>
          <ChevronDown size={16} className={saved.selectedId===run.id?'is-open':''}/><span><strong>{run.number?`Lần ${run.number}`:'Đang tạo lần nhận diện…'}</strong>
            <small>{time(run.startedAt)}{run.endedAt?' – '+time(run.endedAt):''} · {run.peopleCount} người · {run.eventCount} đợt</small></span>
          {run.id===saved.activeId&&<i className="history-recording">Đang ghi</i>}</button>
          <button className="icon-button" disabled={run.id===saved.activeId} aria-label={`Xóa lần ${run.number}`}
            title={run.id===saved.activeId?'Kết thúc lần đang ghi trước khi xóa':'Xóa lần nhận diện và ảnh'} onClick={()=>{if(window.confirm(`Xóa Lần ${run.number} ngày ${dayLabel(run.date)} và ảnh đã lưu?`))void history.removeRun(run.id);}}><Trash2 size={14}/></button></div>
        {saved.selectedId===run.id&&<div className="history-run-content">{saved.loading?<p className="history-loading">Đang tải…</p>:
          !captures.length?<div className="history-no-alert"><ScanFace size={24}/><p>Chưa có cảnh báo trong lần này.</p></div>:
          <ul className="attention-list" aria-label={`Người đã ghi nhận trong Lần ${run.number}`}>{captures.map(capture=><li className="attention-card" key={capture.captureId} data-capture-id={capture.trackId}>
            <div className="attention-portrait history-photo">{capture.photoUrl?<img src={capture.photoUrl} alt={`Ảnh ${capture.displayName} khi ghi nhận cảnh báo`}/>:
              <div className="attention-no-face"><ScanFace size={26}/><span>Chưa có ảnh</span></div>}<span className="attention-person-id">{capture.trackId}</span></div>
            <div className="attention-details"><div className="attention-person-title">{editing===capture.captureId?
              <input autoFocus aria-label={`Tên học sinh ${capture.trackId}`} maxLength={60} defaultValue={capture.displayName}
                onBlur={event=>{session.rename(capture.trackId,event.currentTarget.value);setEditing(undefined);}}
                onKeyDown={event=>{if(event.key==='Escape'){event.currentTarget.value=capture.displayName;event.currentTarget.blur();}else if(event.key==='Enter')event.currentTarget.blur();}}/>:
              editable(capture)?<button className="attention-name" aria-label={`Đổi tên ${capture.displayName}`} onClick={()=>setEditing(capture.captureId)}>{capture.displayName}<Pencil size={12}/></button>:<strong>{capture.displayName}</strong>}
              <span className={'attention-state '+(active.has(capture.trackId)&&editable(capture)?'is-active':'')}>{active.has(capture.trackId)&&editable(capture)?'Đang cảnh báo':'Đã ghi nhận'}</span></div>
              <ul className="attention-reasons">{capture.labels.map(label=><li key={label}>{label}</li>)}</ul>
              <p className="attention-time"><time dateTime={new Date(capture.lastAt).toISOString()}>{time(capture.lastAt)}</time> · {capture.count} đợt cảnh báo</p>
              {capture.photoBeforeAlert&&<p className="attention-photo-note">Ảnh trước cảnh báo{capture.photoAt?' · '+time(capture.photoAt):''}</p>}
            </div></li>)}</ul>}</div>}
      </section>)}
    </div>
    {saved.savingError&&<p className="history-error" role="status">{saved.savingError}</p>}
    <p className="attention-footnote">Lưu trên máy này. Mỗi học sinh chỉ lưu ảnh và biểu hiện mất tập trung gần nhất trong mỗi lần nhận diện.</p>
  </section>;
}
