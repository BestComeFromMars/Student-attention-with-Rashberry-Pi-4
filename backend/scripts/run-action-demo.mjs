// Replay prepared, provenance-checked videos at real source FPS through the
// production HTTP API. Slow AI skips source frames, never slows the camera.
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,open,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createInferenceEngine} from '../dist/inference.js';
import {createApp} from '../dist/app.js';
import {localAIEnv} from '../local-ai-env.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const work=resolve(root,'.qa/action-demo'),output=resolve(root,'backend/tests/action_demo');
const python=resolve(root,'backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const localEnvironment=await localAIEnv(resolve(root,'backend'));
process.env.AI_ACTIONS_EXPERIMENTAL='1';
if(process.argv.includes('--dataset'))throw Error('This command requires classroom video sources. Configure SAV/SCB classroom sources; unrelated indoor-action videos are not accepted.');
const run=async(command,args)=>{
  const child=spawn(command,args,{cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,...localEnvironment,AI_ACTIONS_EXPERIMENTAL:process.env.AI_ACTIONS_EXPERIMENTAL,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',OPENBLAS_NUM_THREADS:'1'}});
  await new Promise((yes,no)=>{child.once('error',no);child.once('exit',code=>code===0?yes():no(Error(command+' exited '+code)));});
};
await mkdir(work,{recursive:true});
await run(python,[resolve(root,'backend/ai/build_action_demo.py')]);
const manifest=JSON.parse(await readFile(resolve(work,'demo-manifest.json'),'utf8'));
const actionVerification=JSON.parse(await readFile(resolve(root,'backend/models/actions/verification.json'),'utf8'));
for(const video of manifest.videos){
  await run(python,[resolve(root,'backend/ai/export_video_io.py'),'--video',video.path,'--output',work,'--prepare-only']);
}
let engine,server;
try{
  engine=await createInferenceEngine(resolve(root,'backend/models/classroom'));
  server=createServer(createApp({engine}));await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const api='http://127.0.0.1:'+server.address().port+'/api';
  for(const video of manifest.videos){
    const stem=video.name,prepared=resolve(work,stem+'_input_frames');
    const info=JSON.parse(await readFile(resolve(prepared,'metadata.json'),'utf8'));
    const events=[];let lastProgress=0;
    for(const segment of video.segments){
      const response=await fetch(api+'/sessions',{method:'POST'});if(!response.ok)throw Error('Cannot start replay session');
      const id=(await response.json()).sessionId,started=Date.now();
      segment.wallStartedAt=started;
      const segmentMs=(segment.endFrame-segment.startFrame+1)*1000/info.fps;
      try{
        while(Date.now()-started<segmentMs){
          const elapsed=Date.now()-started;
          const frame=Math.min(segment.endFrame,segment.startFrame+Math.floor(elapsed*info.fps/1000));
          const jpeg=await readFile(resolve(prepared,String(frame).padStart(6,'0')+'.jpg'));
          const sent=Date.now();
          const result=await fetch(api+'/sessions/'+id+'/detect',{method:'POST',headers:{'Content-Type':'image/jpeg'},body:jpeg,signal:AbortSignal.timeout(35000)});
          const data=await result.json();if(!result.ok)throw Error('Replay API '+result.status+': '+JSON.stringify(data));
          const received=Date.now(),available=segment.startFrame+Math.ceil((received-started)*info.fps/1000);
          if(available<=segment.endFrame)events.push({availableFrame:available,availableAt:received,imageFrame:frame,tracks:data.tracks,objects:data.objects,latencyMs:received-sent,metrics:engine.metrics});
          if(Date.now()-lastProgress>5000){console.log(stem+': camera frame '+frame+'/'+info.frames);lastProgress=Date.now();}
          await delay(Math.max(0,83-(Date.now()-sent)));
        }
      }finally{await fetch(api+'/sessions/'+id,{method:'DELETE'});}
      events.push({availableFrame:segment.endFrame+1,imageFrame:segment.endFrame+1,tracks:[],objects:[],reset:true});
    }
    const stream=await open(resolve(work,stem+'_predictions.jsonl'),'w');
    let current=null,index=0;
    try{
      for(let frame=1;frame<=info.frames;frame++){
        while(index<events.length&&events[index].availableFrame<=frame){current=events[index++];if(current.reset)current=null;}
        const segment=video.segments.find(s=>s.startFrame<=frame&&s.endFrame>=frame);
        const evaluatedAt=segment.wallStartedAt+(frame-segment.startFrame)*1000/info.fps;
        await stream.write(JSON.stringify({frame,evaluatedAt,timeMs:(frame-1)*1000/info.fps,imageFrame:current?.imageFrame??frame,
          tracks:current?.tracks??[],objects:current?.objects??[]})+'\n');
      }
    }finally{await stream.close();}
    await writeFile(resolve(work,stem+'_events.json'),JSON.stringify(events));
    await writeFile(resolve(work,stem+'_inference.json'),JSON.stringify({...info,predictionsComplete:true,processingSeconds:events.reduce((sum,e)=>sum+(e.latencyMs??0),0)/1000,
      modelCapabilities:engine.capabilities,actionModelVerification:actionVerification,
      sourceClockPaced:true,pipeline:'Production HTTP API and real source FPS; current result image is held exactly as the UI does.'}));
  }
}finally{if(server)await new Promise(done=>server.close(done));await engine?.close();}
await mkdir(output,{recursive:true});
const files=manifest.videos.map(video=>video.name);
if(files.length!==2)throw Error('Exactly two demo videos are required');
const expected=files.map(name=>name+'.mp4');
if((await readdir(output)).some(file=>!expected.includes(file)))throw Error('Output contains unrelated files; preserving them');
await run(process.execPath,[resolve(root,'frontend/scripts/render-ui-videos.mjs'),'--work',work,'--output',output,'--files',files.join(',')]);
await run(python,[resolve(root,'backend/ai/score_action_demo.py')]);
