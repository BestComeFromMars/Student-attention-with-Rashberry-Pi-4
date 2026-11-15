// Replay the seven source videos through the same Sessions.detect API used by
// the web app, then render its actual React overlays. Only MP4s go to --output.
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,open,readdir} from 'node:fs/promises';
import {resolve,basename,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {loadEnvFile} from 'node:process';
import {createInferenceEngine} from '../dist/inference.js';
import {Sessions} from '../dist/sessions.js';
import {localAIEnv} from '../local-ai-env.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
try{loadEnvFile(resolve(root,'backend/.env'));}catch(error){if(error.code!=='ENOENT')throw error;}
// Keep native temporary workspaces from peaking concurrently on this machine.
// Every current model, threshold, session and UI component is retained.
process.env.AI_EXPORT_SERIAL_NATIVE='1';
process.env.AI_EXPORT_VIDEO_TIMELINE='1';
const argv=process.argv.slice(2);
const option=(key,fallback)=>{const index=argv.indexOf(key);return index<0?fallback:argv[index+1];};
const selected=option('--file',null);
const input=selected?dirname(resolve(selected)):resolve(option('--input',resolve(root,'backend/tests/videos')));
const output=resolve(option('--output',resolve(root,'backend/tests/videos_detected')));
const work=resolve(option('--work',resolve(root,'.qa/video-export-ui')));
const files=selected?[basename(resolve(selected))]:Array.from({length:7},(_,index)=>`class_${index+1}.mp4`);
if(files.some(name=>! /^[a-zA-Z0-9_-]+\.mp4$/.test(name)))throw Error('Expected an MP4 filename');
const localEnv=await localAIEnv(resolve(root,'backend'));
const python=resolve(root,'backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
await mkdir(work,{recursive:true});await mkdir(output,{recursive:true});
const extras=(await readdir(output)).filter(name=>!files.includes(name));
if(!selected&&extras.length)throw Error('Output must contain only the seven MP4 videos: '+extras.join(', '));
const run=async(command,args)=>{
  const child=spawn(command,args,{cwd:root,windowsHide:true,stdio:'inherit',env:{...localEnv,
    PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1',OPENBLAS_NUM_THREADS:'1'}});
  await new Promise((yes,no)=>{child.once('error',no);child.once('exit',code=>code===0?yes():no(Error(command+' exited '+code)));});
};
const digest=createHash('sha256');
for(const file of ['backend/ai/models.json','backend/ai/worker.py','backend/ai/perception.py','backend/ai/perception_process.py',
  'backend/ai/geometry.py','backend/ai/person_tracking.py','backend/ai/visual_tracking.py',
  'backend/ai/fast_face_tracking.py','backend/ai/face_validation.py',
  'backend/ai/onnx_vittrack.py','backend/ai/object_tracking.py','backend/dist/sessions.js',
  'backend/dist/attention.js','backend/dist/facial-behavior.js','backend/dist/tracker.js',
  'backend/dist/posture-behavior.js','backend/dist/head-motion.js','backend/dist/box-presentation.js','backend/dist/observation-settings.js','backend/dist/speech-motion.js','backend/ai/body_pose.py',
  'backend/ai/head_orientation.py','backend/ai/desk_rest.py','backend/ai/desk_rest_model.json',
  'backend/scripts/export-ui-videos.mjs'])digest.update(await readFile(resolve(root,file)));
const modelKey=digest.digest('hex');
let engine;
try{
  for(const name of selected?files:[files[5],files[6],...files.slice(0,5)]){
    const stem=name.slice(0,-4),infoPath=resolve(work,stem+'_inference.json');
    let previous;
    try{previous=JSON.parse(await readFile(infoPath,'utf8'));}catch{}
    if(argv.includes('--resume')&&previous?.predictionsComplete&&previous.modelKey===modelKey){
      console.log(name+': using complete predictions from the current production pipeline');continue;
    }
    // Decoder exits before model loading, and the browser starts after shutdown.
    await run(python,[resolve(root,'backend/ai/export_video_io.py'),'--video',resolve(input,name),'--output',work,'--prepare-only']);
    const prepared=resolve(work,stem+'_input_frames');
    const info=JSON.parse(await readFile(resolve(prepared,'metadata.json'),'utf8'));
    engine=await createInferenceEngine(resolve(root,'backend/models/classroom'));
    // Use video time throughout the existing pipeline, so offline CPU latency
    // cannot expire evidence before its corresponding image is displayed.
    let frameClock=946684800000;
    const sessions=new Sessions(()=>frameClock),id=sessions.create();
    const replayEngine={release:id=>engine.release(id),detectFrame:async(jpeg,context)=>{
      return engine.detectFrame(jpeg,{...context,frameAt:frameClock});
    }};
    const predictions=await open(resolve(work,stem+'_predictions.jsonl'),'w');
    const started=Date.now();let lastProgress=0;
    try{
      for(let frame=1;frame<=info.frames;frame++){
        frameClock=946684800000+(frame-1)*1000/info.fps;
        const jpeg=await readFile(resolve(prepared,String(frame).padStart(6,'0')+'.jpg'));
        const tracks=await sessions.detect(id,jpeg,replayEngine);
        const objects=sessions.objects(id);
        const errors=['analysisError','geometryError','objectTrackingError','poseError'].map(key=>engine.metrics?.[key]).filter(Boolean);
        if(errors.length)throw Error('Backend pipeline error; incomplete predictions will not be exported: '+errors.join('; '));
        await predictions.write(JSON.stringify({frame,timeMs:(frame-1)*1000/info.fps,tracks,objects,modelMetrics:engine.metrics})+'\n');
        if(Date.now()-lastProgress>5000||frame===info.frames){
          console.log(`${name}: ${frame}/${info.frames} | faces ${tracks.filter(t=>t.status==='visible').length} | objects ${objects.length}`);lastProgress=Date.now();
        }
      }
      await writeFile(infoPath,JSON.stringify({...info,source:resolve(input,name),modelKey,predictionsComplete:true,
        processingSeconds:(Date.now()-started)/1000,capabilities:engine.capabilities,
        pipeline:'Production Sessions.detect and Sessions.objects on source-video time; unchanged models/thresholds; actual UI components.'},null,2));
    }finally{
      await predictions.close();sessions.delete(id,engine);await engine.close();engine=null;
    }
  }
  await run(process.execPath,[resolve(root,'frontend/scripts/render-ui-videos.mjs'),'--work',work,'--output',output,
    ...(selected?['--files',files.map(name=>name.slice(0,-4)).join(',')]:[])]);
  const actual=(await readdir(output)).sort();
  if(selected?!files.every(name=>actual.includes(name)):JSON.stringify(actual)!==JSON.stringify([...files].sort()))throw Error('Missing output videos');
  console.log('Completed: '+files.length+' UI-annotated video(s) in '+output);
}finally{await engine?.close();}
