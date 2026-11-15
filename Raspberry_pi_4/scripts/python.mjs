// Developer convenience only. Pi services invoke /usr/bin/python3 directly.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const python = process.env.PI_PYTHON || process.env.AI_PYTHON ||
  (process.platform === 'win32' ? fileURLToPath(new URL('../../backend/.venv/Scripts/python.exe', import.meta.url)) : 'python3');
const result = spawnSync(python, process.argv.slice(2), { stdio: 'inherit', windowsHide: true,
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
