import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function runStage(name, script, args = []) {
  console.log(`[START] ${name}...`);
  await new Promise((yes, no) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: backend, stdio: 'inherit', windowsHide: true,
    });
    child.once('error', error => no(new Error(`${name}: ${error.message}`)));
    child.once('exit', (code, signal) => {
      if (code === 0) return yes();
      const reason = signal ? `signal ${signal}`
        : `exit code ${code} (0x${(code >>> 0).toString(16).toUpperCase()})`;
      no(new Error(`${name} failed: ${reason}. Backend has not started.`));
    });
  });
}

try {
  await runStage('AI setup', resolve(backend, 'scripts/setup-ai.mjs'));
  await runStage('Backend build', resolve(backend, '../scripts/build.mjs'), ['backend']);
  console.log('[START] Setup and build complete; starting backend.');
} catch (error) {
  console.error('[START] ' + error.message);
  process.exitCode = 1;
}
