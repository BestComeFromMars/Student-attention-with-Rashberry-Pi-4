import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';

// Exercise the production entry point on a temporary port, then its real shutdown handler.
const reservation=createServer();
await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
const port=reservation.address().port;
await new Promise(resolve=>reservation.close(resolve));
process.env.PORT=String(port);
process.env.HOST='127.0.0.1';
// This check must not contact or change the user's physical camera controller.
process.env.PI_CONTROL_URL='';
process.env.HISTORY_DIR=fileURLToPath(new URL('../../.qa/startup-history/'+Date.now()+'/',import.meta.url));
await import('../dist/index.js');
const statuses=[];
try{
  const deadline=Date.now()+90000;
  let finished=false;
  while(Date.now()<deadline){
    const response=await fetch('http://127.0.0.1:'+port+'/api/health',{signal:AbortSignal.timeout(3000)});
    assert.equal(response.status,200);
    const health=await response.json();
    if(statuses.at(-1)!==health.status){statuses.push(health.status);console.log('HTTP health:',health.status);}
    const history=await fetch('http://127.0.0.1:'+port+'/api/history/days');
    assert.equal(history.status,200,'Production history store must be connected even while AI loads');
    assert(Array.isArray((await history.json()).days));
    if(health.status==='error')throw new Error(health.error);
    if(process.argv.includes('--cancel')){
      assert.equal(health.status,'loading');
      console.log('Startup cancellation: HTTP responded while AI was still loading.');
      finished=true;
      break;
    }
    if(health.modelReady){
      assert(statuses.includes('loading'));
      assert.equal(health.detector,'classroom');
      console.log('Production startup: HTTP loading → AI ready. Passed.');
      finished=true;
      break;
    }
    await delay(500);
  }
  assert(finished,'AI startup timed out');
  if(!process.argv.includes('--cancel')){
    const origin='http://127.0.0.1:'+port;
    const runId=randomUUID(),captureId=randomUUID(),startedAt=Date.now();
    const request=async(path,method='GET',body)=>fetch(origin+'/api/history'+path,{method,
      ...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
    const create={id:runId,startedAt,source:'webcam',cameraLabel:'Production startup fixture'};
    assert.equal((await request('/runs','POST',create)).status,201);
    assert.equal((await request('/runs','POST',create)).status,201);
    const portrait=await sharp(fileURLToPath(new URL('../test-fixtures/faces/two-frontal-profile.jpg',import.meta.url)))
      .resize(160,160).jpeg().toBuffer();
    assert.equal((await request('/runs/'+runId+'/captures','PUT',{captures:[{captureId,trackId:'A',displayName:'Kiểm thử',
      labels:['Quay lệch hướng lâu'],count:1,revision:1,firstAt:startedAt,lastAt:startedAt,
      photo:'data:image/jpeg;base64,'+portrait.toString('base64')}]})).status,200);
    const stored=await (await request('/runs/'+runId)).json();assert.equal(stored.captures.length,1);
    assert.equal((await (await request('/runs/'+runId+'/captures/'+captureId+'/photo')).arrayBuffer()).byteLength>0,true);
    assert.equal((await request('/runs/'+runId,'PATCH',{endedAt:Date.now()})).status,200);
    assert.equal((await request('/runs/'+runId,'DELETE')).status,204);
    assert.equal((await request('/runs','POST',create)).status,410);
    console.log('Production history API: idempotent start → save → photo → end → delete → reject late retry. Passed.');
    const image=await sharp(fileURLToPath(new URL('../test-fixtures/faces/two-frontal-profile.jpg',import.meta.url)))
      .resize({width:640,withoutEnlargement:true}).jpeg({quality:85}).toBuffer();
    const created=await fetch(origin+'/api/sessions',{method:'POST'});
    assert.equal(created.status,201);const {sessionId}=await created.json();
    let receivedBoxes=false;
    try{
      // Repeated public stills test the API bridge, not motion or camera FPS.
      // Let the native asynchronous detector finish its first scan and seed
      // the separate pixel worker through the production InferenceRuntime.
      for(let frameId=1;frameId<=20;frameId++){
        const tracked=await fetch(origin+`/api/sessions/${sessionId}/track`,{
          method:'POST',body:image,headers:{'Content-Type':'image/jpeg','X-Frame-Id':String(frameId),
            'X-Frame-Captured-At':String(frameId*1000/30)},signal:AbortSignal.timeout(5000)});
        assert.equal(tracked.status,200,'Production /track failed: '+await tracked.clone().text());
        const geometry=await tracked.json();assert.equal(geometry.frameId,frameId);
        if(geometry.boxes.some(box=>box.key.startsWith('person:')||box.key.startsWith('face:'))){receivedBoxes=true;break;}
        const detected=await fetch(origin+`/api/sessions/${sessionId}/detect`,{
          method:'POST',body:image,headers:{'Content-Type':'image/jpeg','X-Frame-Id':String(frameId)},
          signal:AbortSignal.timeout(60000)});
        assert.equal(detected.status,200,'Production /detect failed: '+await detected.clone().text());
        const result=await detected.json();assert(result.memory&&result.memory.limit>=1&&result.memory.limit<=40);
        assert(result.memory.processed<=result.memory.limit);assert(result.tracks.filter(track=>track.status==='visible').length<=result.memory.limit);
        await delay(200);
      }
      assert(receivedBoxes,'Production runtime did not seed any detected person/face into the pixel worker');
      console.log('Production camera API: /track → /detect → seeded current-frame boxes. Passed.');
    }finally{
      assert.equal((await fetch(origin+'/api/sessions/'+sessionId,{method:'DELETE'})).status,204);
    }
  }
}finally{
  process.emit('SIGINT');
}
