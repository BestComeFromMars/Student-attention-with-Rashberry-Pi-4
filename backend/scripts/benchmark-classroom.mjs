import {createInferenceEngine} from '../dist/inference.js';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url));
const outputIndex=process.argv.indexOf('--output');
if(outputIndex>=0&&!process.argv[outputIndex+1])throw new Error('--output requires a path');
const outputPath=resolve(root,outputIndex>=0?process.argv[outputIndex+1]:'.qa/classroom-benchmark.json');
const engine=await createInferenceEngine(resolve(root,'backend/models/classroom'));
const results=[];
try{
  for(const count of [10,20,40]){
    const original=await readFile(resolve(root,`.qa/classroom-${count}-64.jpg`));
    const images=await Promise.all([0,2,4,2].map(async shift=>sharp(original).extract({left:shift,top:0,width:1916,height:1080})
      .extend({left:0,right:4,top:0,bottom:0,background:'#ebebeb'}).jpeg({quality:90}).toBuffer()));
    const sessionId='benchmark-'+count;
    const times=[],counts=[];
    let stableStart = null, stableResponses = 0;
    let validFaces=0;
    const beginning=performance.now();
    for(let frame=0;performance.now()-beginning<12000;frame++){
      const started=performance.now();
      const people=await engine.detect(images[frame%images.length],{sessionId});
      times.push(performance.now()-started);
      counts.push(people.length);
      if(stableStart===null&&people.length>=count*.9)stableStart=performance.now();
      else if(stableStart!==null)stableResponses++;
      validFaces=Math.max(validFaces,people.filter(face=>face.observation?.valid).length);
      assert(!engine.metrics?.analysisError,engine.metrics?.analysisError);
      assert(people.every(face=>face.boxKind==='face'));
      await delay(Math.max(0,1000/30-(performance.now()-started)));
    }
    const elapsed=performance.now()-beginning;
    const steady=times.slice(1).sort((a,b)=>a-b);
    const result={expectedFaces:count,source:'synthetic repeated portrait, 1920x1080, ~64px faces',
      responseCount:times.length,lastFaceCount:counts.at(-1),minimumFaceCount:Math.min(...counts),
      maxValidLandmarkFaces:validFaces,observedResponseFps:+(times.length*1000/elapsed).toFixed(2),
      steadyResponseFps:stableStart===null?0:+(stableResponses*1000/(performance.now()-stableStart)).toFixed(2),
      bootstrapMs:+times[0].toFixed(2),meanSteadyResponseMs:+(steady.reduce((a,b)=>a+b,0)/steady.length).toFixed(2),
      p95SteadyResponseMs:+steady[Math.floor(steady.length*.95)].toFixed(2),metrics:engine.metrics};
    results.push(result);
    console.log(JSON.stringify(result));
    await writeFile(outputPath,JSON.stringify({note:'Synthetic repeated faces; not real classroom accuracy or physical range.',results},null,2)+'\n');
    assert(result.lastFaceCount>=count*.9,'Expected at least 90% synthetic faces after continuous rescans');
    engine.release(sessionId);
  }
  await writeFile(outputPath,JSON.stringify({
    note:'Whole local inference pipeline active; synthetic face grid only. Not real-classroom accuracy, behavior validation, browser FPS, or physical range.',results},null,2)+'\n');
}finally{await engine.close();}
