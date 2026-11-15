// Public fixtures only. Real local models, no physical camera or image writes.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { createInferenceEngine } from '../dist/inference.js';
const original = await readFile(new URL('../test-fixtures/faces/two-frontal-profile.jpg',import.meta.url));
const engine = await createInferenceEngine(fileURLToPath(new URL('../models/classroom/',import.meta.url)));
const results=[];
try {
  const {width,height}=await sharp(original).metadata();
  const noise=Buffer.alloc(width*height*3);
  let seed=2;
  for(let i=0;i<noise.length;i++) {seed=(Math.imul(seed,1664525)+1013904223)>>>0;noise[i]=(seed>>>24)%30;}
  const cases = [
    ['clear',original,2],
    ['severe-dark',await sharp(original).modulate({brightness:.1}).jpeg().toBuffer(),2],
    ['blur',await sharp(original).blur(6).jpeg().toBuffer(),2],
    // Extreme blur is reported, rather than requiring an invented face.
    ['severe-blur',await sharp(original).blur(20).jpeg().toBuffer(),null],
    ['blank',await sharp({create:{width,height,channels:3,background:'#000'}}).jpeg().toBuffer(),0],
    ['dark-noise',await sharp(noise,{raw:{width,height,channels:3}}).jpeg().toBuffer(),0],
    ['clear-after-poor',original,2],
  ];
  for(const [name,image,expected] of cases) {
    const sessionId='quality-'+name,counts=[],timings=[];
    try {
      for(let frame=0;frame<12;frame++) {
        const people=await engine.detect(image,{sessionId});counts.push(people.length);
        timings.push({geometryMs:engine.metrics?.geometryMs,rescanMs:engine.metrics?.rescanMs,
          candidates:engine.metrics?.candidateFaceCount,hidden:engine.metrics?.hiddenFaceCount});
        assert(!engine.metrics?.analysisError && !engine.metrics?.geometryError);
        await delay(100);
      }
      results.push({name,expected,counts,timings});
      console.log(JSON.stringify({name,expected,counts}));
      if(expected!==null) assert(counts.every(count=>count===expected),name+' must publish '+expected+' faces throughout');
      else assert(counts.every(count=>count<=2),'extreme blur must not invent extra people');
    } finally {engine.release(sessionId);}
  }
  await writeFile(new URL('../../.qa/lowlight-verification.json',import.meta.url),JSON.stringify({
    checkedAt:new Date().toISOString(),note:'Quality is diagnostic, not a detection veto. Public fixture with synthetic darkness/blur and negative controls; not physical low-light accuracy.',results,
  },null,2));
} finally {await engine.close();}
