import { useEffect, useState } from 'react';
import type { HealthResponse } from '../lib/types';
import { setRuntimeProfileHints, type RuntimeProfileHints } from '../lib/detection-settings';

type HealthState = 'checking' | 'ready' | 'loading' | 'missing' | 'unavailable' | 'outdated' | 'error';

export function useBackendHealth() {
  const [health, setHealth] = useState<{ state: HealthState; error?: string; hints?: RuntimeProfileHints }>({ state: 'checking' });
  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let active: AbortController | undefined;
    const check = async () => {
      active = new AbortController();
      const timeout = setTimeout(() => active?.abort(), 5000);
      let interval = 2000;
      try {
        const response = await fetch('/api/health', { signal: active.signal });
        if (!response.ok) throw new Error('Backend unavailable');
        const data: HealthResponse = await response.json();
        if (stopped) return;
        const hints: RuntimeProfileHints = {
          profile: typeof data.capabilities?.profile === 'string' ? data.capabilities.profile : undefined,
          maxDetectEdge: typeof data.capabilities?.maxDetectEdge === 'number' ? data.capabilities.maxDetectEdge : undefined,
          maxTrackEdge: typeof data.capabilities?.maxTrackEdge === 'number' ? data.capabilities.maxTrackEdge : undefined,
          personModel: typeof data.capabilities?.people === 'string' ? data.capabilities.people : undefined,
          privateMemoryMB: typeof data.metrics?.privateMemoryMB === 'number' ? data.metrics.privateMemoryMB : undefined,
        };
        setRuntimeProfileHints(hints);
        const state: HealthState = data.status === 'loading' ? 'loading' : data.status === 'error' ? 'error'
          : !data.modelReady ? 'missing' : data.detector === 'classroom' ? 'ready' : 'outdated';
        setHealth({ state, error: state === 'error' ? data.error : undefined, hints });
        interval = state === 'ready' ? 5000 : 2000;
      } catch {
        if (!stopped) setHealth({ state: 'unavailable' });
      } finally {
        clearTimeout(timeout);
        if (!stopped) retry = setTimeout(() => { void check(); }, interval);
      }
    };
    void check();
    return () => { stopped = true; clearTimeout(retry); active?.abort(); };
  }, []);
  return health;
}
