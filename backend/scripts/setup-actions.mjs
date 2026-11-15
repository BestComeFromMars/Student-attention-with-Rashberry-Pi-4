import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {localAIEnv} from '../local-ai-env.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const env=await localAIEnv(resolve(root,'backend'));
const python=resolve(root,'backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const run=async args=>{
  const processHandle=spawn(python,args,{cwd:root,windowsHide:true,stdio:'inherit',env:{...env,
    PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1'}});
  await new Promise((yes,no)=>{processHandle.once('error',no);processHandle.once('exit',code=>code===0?yes():no(Error('Action setup exited '+code)));});
};
await run(['-m','pip','install','-r',resolve(root,'backend/ai/requirements-actions.txt'),'--disable-pip-version-check']);
await run([resolve(root,'backend/scripts/fetch-action-research.py'),'--weights','--data']);
await run([resolve(root,'backend/ai/prepare_actions.py')]);
await run([resolve(root,'backend/ai/benchmark_actions_runtime.py'),'--threads','2']);
