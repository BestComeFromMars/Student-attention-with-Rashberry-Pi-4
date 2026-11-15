import type {StudentTrack} from './types';
const ORDER=['slumped_on_desk','take_notes','read','flip_books','raise_hand','applaud','turn_around',
  'talk_with_others','answer_questions','bend','touch_sth','hands_down','look_sideways','look_forward','stand','sit'];
export function activityLabel(track:StudentTrack){
  if(track.actionAlert)return track.actionAlert.label;
  const actions=(track.actions??[]).filter(a=>a.state==='confirmed'||a.state==='pending')
    .sort((a,b)=>Number(b.state==='confirmed')-Number(a.state==='confirmed')||ORDER.indexOf(a.type)-ORDER.indexOf(b.type));
  const confirmed=actions.filter(a=>a.state==='confirmed').slice(0,2);
  return confirmed.length?confirmed.map(a=>a.label).join(' · '):actions[0]?'Đang xác nhận: '+actions[0].label:undefined;
}
