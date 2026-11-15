import {createServer as createHttpServer} from 'node:http';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createServer,createLogger} from 'vite';

// Verify the real Vite health middleware without AI, webcam, or fixed application ports.
const upstream=createHttpServer((request,response)=>{
  response.setHeader('Content-Type','application/json');
  response.end(JSON.stringify(request.url==='/api/health'?health:{proxied:true}));
});
let health={status:'loading',modelReady:false,detector:'classroom'};
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
const port=upstream.address().port;
await new Promise(resolve=>upstream.close(resolve));
const previous=process.env.BACKEND_URL;
process.env.BACKEND_URL='http://127.0.0.1:'+port;
const errors=[];
const logger=createLogger('silent');
logger.error=(message)=>errors.push(message);
let vite;
try{
  vite=await createServer({
    root:fileURLToPath(new URL('../',import.meta.url)),
    optimizeDeps:{noDiscovery:true,include:[]},
    customLogger:logger,server:{host:'127.0.0.1',port:0,strictPort:true},
  });
  await vite.listen();
  const url='http://127.0.0.1:'+vite.httpServer.address().port;
  const offline=await fetch(url+'/api/health');
  assert.equal(offline.status,503);
  assert.equal((await offline.json()).status,'unavailable');
  await new Promise(resolve=>upstream.listen(port,'127.0.0.1',resolve));
  assert.equal((await (await fetch(url+'/api/health')).json()).status,'loading');
  health={...health,status:'ok',modelReady:true};
  assert.equal((await (await fetch(url+'/api/health')).json()).modelReady,true);
  health={...health,status:'error',modelReady:false,error:'Test model failure'};
  assert.equal((await (await fetch(url+'/api/health')).json()).error,'Test model failure');
  assert.equal((await (await fetch(url+'/api/example')).json()).proxied,true);
  assert(!errors.some(message=>message.includes('http proxy error')),'Health retries must not produce proxy stack traces');
  console.log('Vite: backend offline → loading → ready → readable AI failure; API proxy preserved. Passed.');
}finally{
  if(vite)await vite.close();
  upstream.closeAllConnections();
  if(upstream.listening){const closed=once(upstream,'close');upstream.close();await closed;}
  if(previous===undefined)delete process.env.BACKEND_URL;
  else process.env.BACKEND_URL=previous;
}
