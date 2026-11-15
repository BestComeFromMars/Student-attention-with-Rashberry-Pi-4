import { useEffect, useState, useSyncExternalStore } from 'react';
import { ObservationSession } from '../lib/session';

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
    navigator.mediaDevices?.addEventListener?.('devicechange', update);
    window.addEventListener('pagehide', release);
    window.addEventListener('pageshow',restore);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.('devicechange', update);
      window.removeEventListener('pagehide', release);
      window.removeEventListener('pageshow',restore);
      // Dev refresh/StrictMode replays this effect while preserving its state.
      // Release devices and invalidate pending work without permanently closing
      // the controller that the next setup will reuse.
      session.stopCamera();
      session.setPiShutdownMonitoring(false);
    };
  }, [session]);
  return { session, state };
}
