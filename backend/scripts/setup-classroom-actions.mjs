import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {localAIEnv} from '../local-ai-env.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const env=await localAIEnv(resolve(root,'backend'));
const python=resolve(root,'backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const run=async args=>{
  const code=await new Promise((done,reject)=>{
    const child=spawn(python,args,{cwd:root,env,windowsHide:true,stdio:'inherit'});child.on('error',reject);child.on('exit',done);
  });
  if(code!==0)throw Error('SCB setup failed at '+args.join(' ')+' (exit '+code+')');
};
await run(['-m','pip','install','--no-deps','-r',resolve(root,'backend/ai/requirements-classroom.txt'),'--disable-pip-version-check']);
await run([resolve(root,'backend/scripts/fetch-scb.py')]);
await run([resolve(root,'backend/ai/prepare_scb.py')]);
await run([resolve(root,'backend/ai/verify_scb_export.py')]);
await run([resolve(root,'backend/ai/evaluate_scb.py')]);
console.log('Official three-class SCB model prepared locally. Accuracy/performance gates still apply; this is not a six-class SCB3 checkpoint.');
