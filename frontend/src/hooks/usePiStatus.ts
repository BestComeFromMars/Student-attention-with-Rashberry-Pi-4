import { useEffect, useState } from 'react';
import type { PiStatus } from '../lib/types';

/** Device presence is independent of whether its webcam is currently switched on. */
export function usePiStatus() {
  const [pi, setPi] = useState<PiStatus | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: AbortController | undefined;
    const check = async () => {
      active = new AbortController();
      try {
        const response = await fetch('/api/pi/status', {
          signal: AbortSignal.any([active.signal, AbortSignal.timeout(4000)]),
        });
        if (!response.ok) throw new Error('Pi status unavailable');
        const value = await response.json();
        if (!stopped) setPi(previous => {
          if (typeof value?.deviceOnline !== 'boolean') return null;
          return previous && previous.deviceOnline === value.deviceOnline && previous.state === value.state && previous.error === value.error
            ? previous : value;
        });
      } catch {
        if (!stopped) setPi(null);
      } finally {
        if (!stopped) timer = setTimeout(() => { void check(); }, 2500);
      }
    };
    void check();
    return () => { stopped = true; clearTimeout(timer); active?.abort(); };
  }, []);
  return pi;
}
