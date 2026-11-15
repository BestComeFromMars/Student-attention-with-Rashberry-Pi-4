import { copyFile, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { root, npm, exists, checkNode, ensurePython, ensurePort, run } from './runtime.mjs';

try {
  checkNode();
  const checkOnly = process.argv.includes('--check');
  if (checkOnly) {
    const { python } = await import('./runtime.mjs');
    for (const path of ['backend/node_modules/express/package.json', 'frontend/node_modules/vite/package.json',
      'backend/models/classroom/installation.json', 'backend/dist/index.js']) {
      if (!await exists(resolve(root, path))) throw new Error('Chưa cài đủ: ' + path + '. Chạy npm run requirement.');
    }
    const config = resolve(root, 'backend/.tmp/ultralytics');
    await mkdir(resolve(config, 'Ultralytics'), { recursive: true });
    await run(python, ['-c', 'import torch,cv2,onnxruntime,mediapipe,ultralytics; print("Python AI: OK")'], {
      env: { ...process.env, YOLO_CONFIG_DIR: config, PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' },
    });
    console.log('Môi trường đã sẵn sàng. Chạy npm start tại thư mục gốc.');
  } else {
    for (const [port, host] of [[3000, 'localhost'], [3001, '0.0.0.0']]) await ensurePort(port, host);
    console.log('[1/5] Kiểm tra Python 64-bit; tự tải nếu máy chưa có bản phù hợp.');
    await ensurePython();
    console.log('[2/5] Cài đúng thư viện Node theo package-lock.json.');
    for (const folder of ['backend', 'frontend']) {
      const stage = resolve(root, '.runtime/install', folder + '-' + Date.now());
      const installed = resolve(root, folder, 'node_modules');
      const backup = resolve(root, '.runtime/previous', folder + '-' + Date.now());
      for (const path of [stage, installed, backup]) {
        const local = relative(root, path);
        if (local.startsWith('..') || isAbsolute(local)) throw new Error('Đường dẫn cài đặt phải nằm trong dự án.');
      }
      await mkdir(stage, { recursive: true });
      await mkdir(resolve(root, '.runtime/previous'), { recursive: true });
      for (const name of ['package.json', 'package-lock.json']) await copyFile(resolve(root, folder, name), resolve(stage, name));
      await run(process.execPath, [npm, 'ci', '--no-audit', '--no-fund'], { cwd: stage,
        env: { ...process.env, npm_config_cache: resolve(root, '.npm-cache') } });
      const hadPrevious = await exists(installed);
      if (hadPrevious) await rename(installed, backup);
      try { await rename(resolve(stage, 'node_modules'), installed); }
      catch (error) { if (hadPrevious) await rename(backup, installed); throw error; }
    }
    console.log('[3/5] Tạo cấu hình mẫu nếu chưa có; giữ nguyên cấu hình Pi riêng hiện tại.');
    for (const folder of ['backend', 'frontend']) {
      const target = resolve(root, folder, '.env');
      if (!await exists(target)) await copyFile(target + '.example', target);
    }
    console.log('[4/5] Cài thư viện AI, tải và xác minh SHA-256 mô hình; lần đầu cần vài GB và Internet.');
    await run(process.execPath, [resolve(root, 'backend/scripts/setup-ai.mjs')]);
    console.log('[5/5] Build backend và frontend.');
    await run(process.execPath, [npm, 'run', 'build']);
    await mkdir(resolve(root, '.runtime'), { recursive: true });
    await writeFile(resolve(root, '.runtime/installed.json'), JSON.stringify({ installedAt: new Date().toISOString(),
      node: process.version, platform: process.platform, architecture: process.arch,
      manifest: JSON.parse(await readFile(resolve(root, 'requirement.json'), 'utf8')) }, null, 2) + '\n');
    console.log('\nĐÃ CÀI XONG. Chạy npm start tại thư mục gốc, mở http://localhost:3000.');
    console.log('Webcam máy tính dùng ngay. Pi cần thông tin riêng trong backend/.env hoặc triển khai bằng Raspberry_pi_4/deploy.py.');
  }
} catch (error) { console.error('CÀI ĐẶT: ' + error.message); process.exitCode = 1; }
