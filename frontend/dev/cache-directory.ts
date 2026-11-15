import { createHash, randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

export function viteCacheDirectory(configUrl: string): string {
  let identity: string;
  try { identity = hostname() + '\\' + userInfo().username; }
  catch { identity = 'session-' + randomUUID(); }
  const account = createHash('sha256').update(identity).digest('hex').slice(0, 12);
  return fileURLToPath(new URL('./.vite-cache/' + account + '/', configUrl));
}
