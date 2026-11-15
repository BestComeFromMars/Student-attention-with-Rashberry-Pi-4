import {describe,it,expect} from 'vitest';
import {createServer} from 'node:http';
import {createApp} from '../src/app.js';
import {Sessions} from '../src/sessions.js';
import type {InferenceEngine} from '../src/types.js';

describe('camera capture timing through the real HTTP session route',()=>{
  it('preserves capture time, accepts legacy clients and rejects malformed timestamps',async()=>{
    const contexts:{frameId:number;capturedAt?:number}[]=[];
    const engine:InferenceEngine={ready:true,detect:async()=>[],close:async()=>{},trackFrame:async(_jpeg,context)=>{
      contexts.push(context);return {frameId:context.frameId,boxes:[],processingMs:0};
    }};
    const sessions=new Sessions(),id=sessions.create();
    const server=createServer(createApp({engine,sessions}));
    await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));
    const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/sessions/${id}/track`;
    const send=(at?:string)=>fetch(url,{method:'POST',body:new Uint8Array([255,216,255,217]),
      headers:{'Content-Type':'image/jpeg','X-Frame-Id':'12',...(at===undefined?{}:{'X-Frame-Captured-At':at})}});
    try{
      expect((await send('1234.5')).status).toBe(200);
      expect(contexts[0]).toMatchObject({frameId:12,capturedAt:1234.5});
      expect((await send()).status).toBe(200);
      expect(contexts[1].capturedAt).toBeUndefined();
      for(const at of ['NaN','Infinity','-1','bad',' ','9007199254740992'])
        expect((await send(at)).status).toBe(400);
      expect(contexts).toHaveLength(2);
    }finally{
      server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));
    }
  });
});
