import { useEffect, useState, useSyncExternalStore } from 'react';
import { ObservationSession } from '../lib/session';
import {DETECTION_SETTINGS_EVENT,DETECTION_SETTINGS_KEY} from '../lib/detection-settings';

export function useObservation() {
  const [session] = useState(() => new ObservationSession());
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    let cancelled = false;
    session.setPiShutdownMonitoring(true);
    // StrictMode can replay effects. Defer the initial read so its cancelled
    // setup does not perform a second hardware enumeration.
    void Promise.resolve().then(() => { if (!cancelled) void session.refreshDevices(); });
    const update = () => session.markDevicesChanged();
    const release = () => {session.stopCamera();session.setPiShutdownMonitoring(false);};
    const restore=()=>session.setPiShutdownMonitoring(true);
    const externalSettings=(event:StorageEvent)=>{if(event.key===DETECTION_SETTINGS_KEY)session.applyPlaybackSettings();};
    navigator.mediaDevices?.addEventListener?.('devicechange', update);
    window.addEventListener('pagehide', release);
    window.addEventListener('pageshow',restore);
    window.addEventListener(DETECTION_SETTINGS_EVENT,session.applyPlaybackSettings);
    window.addEventListener('storage',externalSettings);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.('devicechange', update);
      window.removeEventListener('pagehide', release);
      window.removeEventListener('pageshow',restore);
      window.removeEventListener(DETECTION_SETTINGS_EVENT,session.applyPlaybackSettings);
      window.removeEventListener('storage',externalSettings);
      // Dev refresh/StrictMode replays this effect while preserving its state.
      // Release devices and invalidate pending work without permanently closing
      // the controller that the next setup will reuse.
      session.stopCamera();
      session.setPiShutdownMonitoring(false);
    };
  }, [session]);
  return { session, state };
}
