import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {localAIEnv} from '../local-ai-env.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const python=process.env.AI_PYTHON||resolve(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const result=spawnSync(python,['-m','unittest','discover','-s','ai','-p','test_*.py','-v'],{
  cwd:root,stdio:'inherit',windowsHide:true,
  env:await localAIEnv(root),
});
if(result.error)throw result.error;
process.exitCode=result.status??1;
