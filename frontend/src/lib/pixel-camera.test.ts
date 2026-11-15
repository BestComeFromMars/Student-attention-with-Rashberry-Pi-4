import {afterEach,describe,it,expect,vi} from 'vitest';
import {PixelCamera,type CameraFrame} from './pixel-camera';

vi.mock('./frame-encoder',()=>({FrameEncoder:class{
  async encode(source:ImageBitmap){return {image:new Blob(['jpeg']),bitmap:await createImageBitmap(source)};}
  dispose(){}
}}));
afterEach(()=>vi.unstubAllGlobals());

describe('atomic current-pixel camera presentation',()=>{
  it('keeps matching immutable pixels when transport is delayed, and frame IDs advance after resume',async()=>{
    let pixels=10,sequence=0;
    const source={videoWidth:640,videoHeight:480,currentTime:0,
      requestVideoFrameCallback:vi.fn(()=>1),cancelVideoFrameCallback:vi.fn()} as unknown as HTMLVideoElement;
    vi.stubGlobal('createImageBitmap',vi.fn(async(input:unknown)=>({width:640,height:480,
      pixels:input===source?pixels:(input as {pixels:number}).pixels,close:vi.fn()})));
    let respond!:(response:Response)=>void;
    const frameIds:number[]=[];
    const captureTimes:number[]=[];
    vi.stubGlobal('fetch',vi.fn((_path:string,options:RequestInit)=>{
      frameIds.push(Number(new Headers(options.headers).get('X-Frame-Id')));
      captureTimes.push(Number(new Headers(options.headers).get('X-Frame-Captured-At')));
      return new Promise<Response>(resolve=>{respond=resolve;});
    }));
    const presented:(CameraFrame|null)[]=[];
    const next=()=>++sequence;
    const first=new PixelCamera(async()=>'/session',source,null,frame=>presented.push(frame),next);
    const started=first.start();
    await vi.waitFor(()=>expect(frameIds).toEqual([1]));
    pixels=99; // Camera advances while the geometry response is still waiting.
    respond(new Response(JSON.stringify({frameId:1,boxes:[{key:'face:A',box:{x:.1,y:.1,width:.2,height:.2}}],processingMs:5})));
    await started;
    expect((presented[0]!.image as unknown as {pixels:number}).pixels).toBe(10);
    expect(presented[0]!.frameId).toBe(1);
    expect(captureTimes[0]).toBe(presented[0]!.capturedAt);
    expect(captureTimes[0]).toBeGreaterThanOrEqual(0);
    const snapshot=await first.snapshot();
    expect(snapshot.id).toBe(1);expect((snapshot.image as unknown as {pixels:number}).pixels).toBe(10);
    snapshot.image.close();first.stop();
    const second=new PixelCamera(async()=>'/session',source,null,frame=>presented.push(frame),next);
    const resumed=second.start();await vi.waitFor(()=>expect(frameIds).toEqual([1,2]));
    respond(new Response(JSON.stringify({frameId:2,boxes:[],processingMs:5})));await resumed;
    expect((presented.at(-1)!.image as unknown as {pixels:number}).pixels).toBe(99);
    second.stop();expect(presented.at(-1)).toBeNull();
  });
});
