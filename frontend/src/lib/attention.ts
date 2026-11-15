import type { StudentTrack } from './types';

export const STATUS_KEYS = ['uncertain', 'needs_attention'] as const;
const APPEARANCE = {
  focused: { label: 'AI đang quan sát', color: '#eab308', text: '#422006' },
  uncertain: { label: 'AI đang quan sát', color: '#eab308', text: '#422006' },
  needs_attention: { label: 'Cần chú ý', color: '#ef4444', text: '#ffffff' },
};
export function statusAppearance(track: Pick<StudentTrack, 'attention'> & Partial<Pick<StudentTrack, 'status' | 'alerts'>>) {
  if (track.status === 'lost') return track.attention === 'needs_attention' && track.alerts?.length
    ? { ...APPEARANCE.needs_attention, label: 'Cần chú ý · tạm mất dấu' } : APPEARANCE.uncertain;
  return APPEARANCE[track.attention ?? 'uncertain'];
}
