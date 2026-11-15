import {ScanFace,Trash2,RotateCcw,Pencil} from 'lucide-react';
import {useState} from 'react';
import type {SessionSnapshot,ObservationSession} from '../lib/session';
import HistoryPanel from './HistoryPanel';

const time=(at:number)=>new Intl.DateTimeFormat('vi-VN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(at);
export default function AttentionList(props:{state:SessionSnapshot;session:ObservationSession;inert?:boolean}){
  return props.session.history?<HistoryPanel {...props} history={props.session.history}/>:<LiveAttentionList {...props}/>;
}
function LiveAttentionList({state,session,inert=false}:{state:SessionSnapshot;session:ObservationSession;inert?:boolean}){
  const captures=state.captures??[];
  const [editing,setEditing]=useState<string|null>(null);
  const active=new Set(state.tracks.filter(track=>track.status==='visible'&&track.attention==='needs_attention').map(track=>track.id));
  return <section className="attention-panel" aria-label="Danh sách cần chú ý" inert={inert}>
    <div className="attention-toolbar">
      <div className="attention-actions"><button className="icon-button" aria-label="Xóa danh sách cần chú ý" title="Xóa ảnh và danh sách đã ghi nhận"
        disabled={!captures.length} onClick={()=>session.clearCaptures()}><Trash2 size={16}/></button>
        <button className="icon-button" aria-label="Đặt lại phiên nhận diện" title="Đặt lại mã người và danh sách"
          disabled={!state.tracks.length&&!captures.length&&state.detection!=='running'} onClick={()=>session.reset()}><RotateCcw size={16}/></button></div>
    </div>
    {!captures.length?<div className="attention-empty"><span><ScanFace size={32} strokeWidth={1.5}/></span>
      <h3>Chưa có cảnh báo</h3><p>Khi có dấu hiệu cần chú ý, ảnh mặt và thông tin sẽ xuất hiện ở đây.</p></div>:
      <ul className="attention-list" aria-label="Người đã ghi nhận cảnh báo">{captures.map(capture=><li className="attention-card" key={capture.id} data-capture-id={capture.id}>
        <div className="attention-portrait">{capture.photo?<img src={capture.photo} alt={`Ảnh mặt ${capture.displayName} khi ghi nhận cảnh báo`}/>:
          <div className="attention-no-face"><ScanFace size={26}/><span>Chưa chụp được mặt</span></div>}<span className="attention-person-id">{capture.id}</span></div>
        <div className="attention-details"><div className="attention-person-title">{editing===capture.id?
          <input autoFocus aria-label={`Tên học sinh ${capture.id}`} maxLength={60} defaultValue={capture.displayName}
            onBlur={event=>{session.rename(capture.id,event.currentTarget.value);setEditing(null);}}
            onKeyDown={event=>{if(event.key==='Escape'){event.currentTarget.value=capture.displayName;event.currentTarget.blur();}else if(event.key==='Enter')event.currentTarget.blur();}}/>:
          <button className="attention-name" aria-label={`Đổi tên ${capture.displayName}`} onClick={()=>setEditing(capture.id)}>{capture.displayName}<Pencil size={12}/></button>}
          <span className={'attention-state '+(active.has(capture.id)?'is-active':'')}>{active.has(capture.id)?'Đang cảnh báo':'Đã ghi nhận'}</span></div>
          <ul className="attention-reasons">{capture.labels.map(label=><li key={label}>{label}</li>)}</ul>
          <p className="attention-time"><time dateTime={new Date(capture.lastAt).toISOString()}>{time(capture.lastAt)}</time> · {capture.count} lần ghi nhận</p>
          {capture.photoBeforeAlert&&<p className="attention-photo-note">Ảnh mặt trước cảnh báo{capture.photoAt?' · '+time(capture.photoAt):''}</p>}
        </div>
      </li>)}</ul>}
    <p className="attention-footnote">Ảnh chỉ giữ trong phiên này, xóa khi tắt camera hoặc đặt lại phiên.</p>
  </section>;
}
