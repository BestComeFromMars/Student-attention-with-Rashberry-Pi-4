import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {localAIEnv} from '../local-ai-env.mjs';
const backend=fileURLToPath(new URL('../',import.meta.url));
const child=spawn(resolve(backend,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),
  [resolve(backend,'ai/profile_dense.py')],{cwd:backend,windowsHide:true,stdio:'inherit',
    env:{...await localAIEnv(backend),OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1'}});
child.on('exit',code=>process.exitCode=code??1);
