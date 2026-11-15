// Production models and evaluator, latest frames sent serially, no camera/Pi.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {localAIEnv} from '../local-ai-env.mjs';
import {createInferenceEngine} from '../dist/inference.js';
import {Sessions} from '../dist/sessions.js';
const root=fileURLToPath(new URL('../../',import.meta.url)),backend=resolve(root,'backend'),out=resolve(root,'.qa/fast-motion');
await mkdir(out,{recursive:true});
const prepared=spawnSync(resolve(backend,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),['ai/prepare_fast_motion.py'],{
  cwd:backend,env:await localAIEnv(backend),encoding:'utf8',windowsHide:true});
if(prepared.status!==0)throw new Error(prepared.stderr);
const cases=JSON.parse(await readFile(resolve(out,'cases.json'),'utf8'));
for(const test of cases)test.images=await Promise.all(test.files.map(file=>readFile(resolve(out,file))));
if(process.argv.includes('--debug'))process.env.AI_DEBUG_FACE_TRACKING='1';
const blank=await readFile(resolve(out,'blank.jpg')),engine=await createInferenceEngine(resolve(backend,'models/classroom'));
const sessions=new Sessions(),report={complete:false,scope:'Actual production backend, public speaking video + synthetic 2D abrupt motion. No physical webcam/Pi or human behavior accuracy claim.',cases:[]};
const phase=process.argv.includes('--baseline')?'baseline':process.argv.includes('--debug')?'debug':'after';
function iou(a,b){const area=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));return area/(a.width*a.height+b.width*b.height-area);}
try{
  for(const test of cases){
    if(process.argv.includes('--debug')&&!test.name.includes('sgbe5s2-abrupt'))continue;
    const id=sessions.create(),samples=[];let before;
    try{
      for(let n=0;n<8;n++){await sessions.detect(id,test.images[0],engine);await delay(70);}
      for(const [index,jpeg]of test.images.entries()){
        before=performance.now();const tracks=await sessions.detect(id,jpeg,engine);
        for(const key of ['analysisError','bodyError','bodyTrackingError','poseError','geometryError','objectTrackingError'])
          assert(!engine.metrics?.[key],`${test.name}: ${key}: ${engine.metrics?.[key]}`);
        const visible=tracks.filter(t=>t.status==='visible'&&t.faceVisibility!=='unavailable'&&(t.faceBox||t.boxKind==='face'));
        const overlaps=test.expectedBoxes?.[index]?.map(expected=>Math.max(0,...visible.map(t=>iou(t.faceBox??t.box,expected))));
        samples.push({index,ms:Math.round(performance.now()-before),visibleFaces:visible.length,
          referenceIoUs:overlaps,
          ids:visible.map(t=>t.id),geometryIds:visible.map(t=>t.geometryId),
          boxes:visible.map(t=>({box:t.faceBox??t.box,personId:t.personId,state:t.trackingState})),metrics:{...engine.metrics}});
        await delay(Math.max(0,70-(performance.now()-before)));
      }
      // A stable visible face must be found again, not remain a stale ROI.
      const restore=[];const start=performance.now();
      while(performance.now()-start<1600||restore.length<3){
        const tracks=await sessions.detect(id,test.images[0],engine);
        restore.push({ms:Math.round(performance.now()-start),faces:tracks.filter(t=>t.status==='visible'&&t.faceVisibility!=='unavailable'&&(t.faceBox||t.boxKind==='face')).length});
        await delay(40);
      }
      const sorted=samples.map(s=>s.ms).sort((a,b)=>a-b);
      const result={name:test.name,expectedFaces:test.expectedFaces,frames:samples.length,
        fullFaceFrames:samples.filter(s=>s.visibleFaces===test.expectedFaces).length,
        missingFrames:samples.filter(s=>s.visibleFaces<test.expectedFaces).length,
        duplicateFrames:samples.filter(s=>s.visibleFaces>test.expectedFaces).length,
        locatedFrames:samples.filter(s=>s.referenceIoUs?.every(value=>value>=.3)).length,
        p50Ms:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)],
        recoveryMs:restore.find(s=>s.faces===test.expectedFaces)?.ms??null,restore,samples};
      report.cases.push(result);console.log(JSON.stringify({...result,restore:undefined,samples:undefined}));
      await writeFile(resolve(out,phase+'.json'),JSON.stringify(report,null,2));
    }finally{sessions.delete(id,engine);}
  }
  const id=sessions.create();await sessions.detect(id,cases[0].images[0],engine);
  const negative=[];const started=performance.now();
  while(performance.now()-started<1800){
    const tracks=await sessions.detect(id,blank,engine);
    negative.push({ms:Math.round(performance.now()-started),faces:tracks.filter(t=>t.status==='visible'&&t.faceVisibility!=='unavailable'&&(t.faceBox||t.boxKind==='face')).length});
    await delay(40);
  }
  sessions.delete(id,engine);
  report.exit=negative;
  await writeFile(resolve(out,phase+'.json'),JSON.stringify(report,null,2));
  if(phase!=='baseline'){
    assert(report.cases.every(c=>c.missingFrames===0&&c.duplicateFrames===0),'All controlled speaking/motion frames must retain the expected face count, without duplicates');
    assert(report.cases.every(c=>c.locatedFrames===c.frames),'Current face boxes must overlap the known transformed reference regions');
    assert(report.cases.every(c=>c.restore.slice(-3).every(s=>s.faces===c.expectedFaces)),'Must recover each actual face');
    assert(negative.slice(-3).every(s=>s.faces===0),'Must remove faces on an empty image');
  }
  report.complete=true;
  await writeFile(resolve(out,phase+'.json'),JSON.stringify(report,null,2));
}finally{await engine.close();}
