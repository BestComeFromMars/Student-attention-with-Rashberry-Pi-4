import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createInferenceEngine} from '../dist/inference.js';
import {createApp} from '../dist/app.js';
import {PiSource} from '../dist/pi-source.js';
const backend=fileURLToPath(new URL('../',import.meta.url));
const prepared=spawnSync(process.env.AI_PYTHON||resolve(backend,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),['ai/prepare_pose_cases.py'],{cwd:backend,encoding:'utf8',windowsHide:true});
assert.equal(prepared.status,0,prepared.stderr);
const directory=resolve(backend,'../.qa/pose-cases');
const cases=JSON.parse(await readFile(resolve(directory,'cases.json'),'utf8'));
const engine=await createInferenceEngine(resolve(backend,'models/classroom'));
const pi=new PiSource(),server=createApp({engine,pi}).listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const base='http://127.0.0.1:'+server.address().port+'/api';
async function api(path,options={}){const response=await fetch(base+path,options);assert(response.ok,path+': '+response.status);return response.status===204?null:response.json();}
const report={note:'Public Sheffield native frontal/profile video and controlled fast translation/roll/scale; no user camera; no labelled real-classroom accuracy claim.',capabilities:engine.capabilities,cases:[]};
try {
  for(const test of cases)for(const source of ['upload','pi-route']) {
    const {sessionId}=await api('/sessions',{method:'POST'});const trace=[];let id;
    try {
      for(const name of test.files){
        const jpeg=await readFile(resolve(directory,name));if(source==='pi-route')await pi.update(jpeg);
        const started=performance.now();
        const {tracks}=await api('/sessions/'+sessionId+'/detect'+(source==='pi-route'?'/pi':''),{
          method:'POST',...(source==='upload'?{headers:{'Content-Type':'image/jpeg'},body:jpeg}:{})});
        const visible=tracks.filter(t=>t.status==='visible');
        trace.push({name,ms:performance.now()-started,tracks:tracks.map(t=>({id:t.id,state:t.trackingState,status:t.status,box:t.box})),metrics:engine.metrics});
        id??=visible[0]?.id;
        assert.equal(visible.length,1,'exactly one public face: '+JSON.stringify({test:test.name,mode:test.mode,source,trace}));
        assert.equal(visible[0].id,id,'same person keeps ID: '+JSON.stringify({test:test.name,mode:test.mode,source,trace}));
        assert(!engine.metrics?.geometryError && !engine.metrics?.analysisError);
        await delay(40);
      }
      const row={name:test.name,mode:test.mode,source,frames:trace.length,id,trace};report.cases.push(row);
      console.log(JSON.stringify({name:row.name,mode:row.mode,source,frames:trace.length,passed:true}));
    } finally {await api('/sessions/'+sessionId,{method:'DELETE'});}
  }
  await writeFile(resolve(directory,'../pose-verification.json'),JSON.stringify(report,null,2));
} finally {await engine.close();await new Promise(resolve=>server.close(resolve));}
