import type { StudentTrack } from '../lib/types';

export function useSmoothTracks(tracks: StudentTrack[], running: boolean, scope = ''): StudentTrack[] {
  // Positions belong to the exact frame painted by ObservationSession.
  // No browser tracker, extrapolation, resize filter or retained ghost boxes.
  void scope;
  return running ? tracks : [];
}
