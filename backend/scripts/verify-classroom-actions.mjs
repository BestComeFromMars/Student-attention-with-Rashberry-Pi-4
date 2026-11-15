import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {localAIEnv} from '../local-ai-env.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const env=await localAIEnv(resolve(root,'backend'));
const python=resolve(root,'backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
for(const script of ['check_scb_installation.py','verify_scb_export.py','evaluate_scb.py']){
  await new Promise((done,reject)=>{
    const child=spawn(python,[resolve(root,'backend/ai',script)],{cwd:root,env,windowsHide:true,stdio:'inherit'});
    child.on('error',reject);
    child.on('exit',(code,signal)=>code===0?done():reject(new Error(script+' failed: '+(signal||code))));
  });
}
console.log('SCB installation and CPU inference checked offline. See .qa/action-demo/scb/validation.json for accuracy; successful execution does not mean the accuracy gate passed.');
