import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const npm = process.env.npm_execpath || resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
export const python = resolve(root, 'backend/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export async function exists(path) { try { await access(path); return true; } catch { return false; } }
export function checkNode() {
  if (process.arch !== 'x64' || !['win32', 'linux'].includes(process.platform)) throw new Error('Bộ cài AI CPU hỗ trợ Windows/Linux x64; cần bản Node.js x64 phù hợp.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 19) throw new Error('Cần Node.js từ 22.19.0. Tải tại https://nodejs.org/en/download');
}
export async function ensurePort(port, host = '127.0.0.1') {
  const probe = createServer();
  await new Promise((yes, no) => {
    probe.once('error', () => no(new Error(`Cổng ${port} đang được sử dụng. Dừng frontend/backend cũ trước khi tiếp tục.`)));
    probe.listen(port, host, () => probe.close(yes));
  });
}
export async function run(command, args, options = {}) {
  const { onChild, ...spawnOptions } = options;
  return new Promise((yes, no) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'inherit', ...spawnOptions });
    onChild?.(child);
    child.once('error', no);
    child.once('exit', code => code === 0 ? yes() : no(new Error('Lệnh cài đặt/kiểm tra kết thúc với mã ' + code)));
  });
}
export async function detectPython() {
  const candidates = process.platform === 'win32'
    ? [['py', '-3.11'], ['py', '-3.10'], ['python'], ['python3']]
    : [['python3.11'], ['python3.10'], ['python3'], ['python']];
  if (process.env.AI_PYTHON_BOOTSTRAP) candidates.unshift([process.env.AI_PYTHON_BOOTSTRAP]);
  for (const [command, ...args] of candidates) {
    try {
      const { stdout } = await promisify(execFile)(command, [...args, '-c',
        'import sys,struct; assert sys.version_info[:2] in [(3,10),(3,11)] and struct.calcsize("P")==8; print(sys.executable)'],
      { windowsHide: true, timeout: 8000 });
      return stdout.trim();
    } catch { /* Try the next compatible runtime. */ }
  }
  return null;
}
export async function ensurePython({ forceManaged = false } = {}) {
  if (!forceManaged && await exists(python)) return python;
  const bootstrap = forceManaged ? null : await detectPython();
  if (bootstrap) { await run(bootstrap, ['-m', 'venv', resolve(root, 'backend/.venv')]); return python; }
  const manifest = JSON.parse(await readFile(resolve(root, 'requirement.json'), 'utf8'));
  if (process.arch !== 'x64' || !['win32', 'linux'].includes(process.platform)) throw new Error('Bộ cài AI CPU hiện hỗ trợ Windows/Linux x64.');
  const spec = manifest.bootstrapPython;
  const model = spec[process.platform];
  const directory = resolve(root, '.runtime/cpython-' + spec.version);
  const executable = resolve(directory, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3.11');
  if (!await exists(executable)) {
    await mkdir(directory, { recursive: true });
    console.log('Đang tải Python ' + spec.version + ' từ Astral python-build-standalone; kiểm tra SHA-256 trước khi giải nén.');
    const source = `https://github.com/astral-sh/python-build-standalone/releases/download/${spec.release}/${model.file}`;
    const archive = await fetch(source, { signal: AbortSignal.timeout(180000) });
    if (!archive.ok) throw new Error('Không tải được Python. Kiểm tra Internet rồi chạy lại requirement.');
    const bytes = Buffer.from(await archive.arrayBuffer());
    if (bytes.length !== model.bytes || createHash('sha256').update(bytes).digest('hex') !== model.sha256) throw new Error('Checksum Python không khớp.');
    const path = resolve(directory, 'python.tar.gz');
    await writeFile(path, bytes);
    await run('tar', ['-xzf', path, '-C', directory]);
  }
  console.log('Tạo môi trường AI riêng; không thay Python hoặc PATH của máy.');
  // setup-ai bootstraps its own pinned pip wheel inside this isolated venv.
  await run(executable, ['-m', 'venv', '--without-pip', resolve(root, 'backend/.venv')]);
  return python;
}
