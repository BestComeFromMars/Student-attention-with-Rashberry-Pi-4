import type {StudentTrack} from './types';
import {activityLabel} from './activity';

const ALERTS:Record<string,string>={upper_body_slumped:'Gục người',eyes_closed:'Nhắm mắt',phone:'Điện thoại',
  head_down:'Cúi đầu',yawn:'Ngáp',talking:'Nói chuyện',laptop:'Laptop',head_turning:'Quay đầu',
  head_turned:'Quay ngang',torso_turned:'Quay thân',turned_smiling:'Quay / cười'};
const ACTIONS:Record<string,string>={slumped_on_desk:'Gục người',read:'Đọc',take_notes:'Viết',raise_hand:'Giơ tay',
  stand:'Đứng',turn_around:'Quay người',talk_with_others:'Trao đổi',applaud:'Vỗ tay'};

/** One short camera badge; full evidence remains in the person list/tooltip. */
export function overlayCaption(track:StudentTrack){
  const alert=[...(track.alerts??[])].sort((a,b)=>Number(b.type==='upper_body_slumped')-Number(a.type==='upper_body_slumped')||Number(a.held)-Number(b.held))[0];
  const warning=Boolean(alert)||Boolean(track.actionAlert)||track.attention==='needs_attention';
  const action=track.actionAlert??track.actions?.find(item=>item.state==='confirmed'&&ACTIONS[item.type]);
  const short=alert?(ALERTS[alert.type]??alert.label):action?(ACTIONS[action.type]??action.label):
    track.studyContext==='book'?'Sách/vở':warning?'Chú ý':undefined;
  const detail=alert?(alert.held?'Vừa ghi nhận: ':'')+alert.label:activityLabel(track)??
    (track.calibration?.state==='collecting'?'Đang lấy hướng chuẩn':track.calibration?.state==='insufficient'?
      'Chưa đủ dữ liệu hướng chuẩn':track.faceVisibility==='unavailable'?'Chưa thấy mặt':undefined);
  return {heading:track.id+(short?' · '+short:''),warning,description:[track.displayName,detail].filter(Boolean).join(' · '),
    color:warning?'#ef4444':'#38bdf8',background:warning?'#7f1d1d':'#0f172a'};
}
