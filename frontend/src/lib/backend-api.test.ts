import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDetector } from './backend-api';
import {FrameEncoder} from './frame-encoder';
import {PixelCamera} from './pixel-camera';
import {DETECTION_SETTINGS_KEY,saveDetectionSettings} from './detection-settings';

let sessionNumber = 0;
const drawImage = vi.fn();
beforeEach(() => {
  localStorage.removeItem(DETECTION_SETTINGS_KEY);
  sessionNumber = 0;
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    if (options?.method === 'DELETE') return new Response(null, { status: 204 });
    if (path === '/api/sessions') return new Response(JSON.stringify({ sessionId: 'session-' + ++sessionNumber }), { status: 201 });
    return new Response(JSON.stringify({ tracks: [{ id: 'A', displayName: 'Học sinh A', status: 'visible', box: { x: 0.1, y: 0.2, width: 0.2, height: 0.5 } }] }));
  }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['jpeg'], { type: 'image/jpeg' })));
});
afterEach(() => { localStorage.removeItem(DETECTION_SETTINGS_KEY);vi.unstubAllGlobals(); });
describe('frontend to backend transport', () => {
  it('keeps recognizing the admitted people during RAM pressure and clears the notice on recovery',async()=>{
    const detector=await createDetector(),video={videoWidth:640,videoHeight:480} as HTMLVideoElement;
    const track={id:'A',displayName:'A',status:'visible',box:{x:.1,y:.1,width:.2,height:.3}};
    const memory={totalMB:8192,availableMB:900,limit:1,detected:3,processed:1,limited:true,pressure:true};
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({tracks:[track],memory})));
    expect(await detector.detect(video)).toHaveLength(1);expect(detector.memory).toEqual(memory);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({tracks:[track],memory:{...memory,limit:20,limited:false,pressure:false}})));
    expect(await detector.detect(video)).toHaveLength(1);expect(detector.memory?.limited).toBe(false);
    detector.dispose();
  });
  it('keeps the immutable frame identity through encoder failure and later canvas fallback',async()=>{
    vi.stubGlobal('Worker',class{terminate=vi.fn();});
    vi.stubGlobal('OffscreenCanvas',class{
      constructor(public width:number,public height:number){}
      getContext(){return {drawImage};}
      async convertToBlob(){return new Blob(['jpeg']);}
    });
    vi.stubGlobal('createImageBitmap',vi.fn());
    vi.spyOn(FrameEncoder.prototype,'encode').mockRejectedValue(new Error('Encoder failed'));
    vi.spyOn(PixelCamera.prototype,'start').mockResolvedValue();
    const first={width:640,height:480,close:vi.fn()} as unknown as ImageBitmap;
    const second={width:640,height:480,close:vi.fn()} as unknown as ImageBitmap;
    vi.spyOn(PixelCamera.prototype,'snapshot').mockResolvedValueOnce({image:first,id:41,at:123})
      .mockResolvedValueOnce({image:second,id:42,at:156});
    const detector=await createDetector(),video={videoWidth:640,videoHeight:480} as HTMLVideoElement;
    await detector.startTracking!(video,null,()=>{});
    await detector.detect(video);
    expect(drawImage).toHaveBeenLastCalledWith(first,0,0,640,480);
    expect(detector.frameTime).toBe(123);
    await detector.detect(video);
    expect(drawImage).toHaveBeenLastCalledWith(second,0,0,640,480);
    expect(fetch).toHaveBeenLastCalledWith('/api/sessions/session-1/detect',expect.objectContaining({
      headers:{'Content-Type':'image/jpeg','X-Frame-Id':'42'},
    }));
    expect(first.close).toHaveBeenCalled();expect(second.close).toHaveBeenCalled();detector.dispose();
  });
  it.each(['person','object'])('rejects malformed display coordinates for a %s',async kind=>{
    const detector=await createDetector();
    const track={id:'A',displayName:'A',status:'visible',box:{x:.1,y:.1,width:.2,height:.3}};
    const invalid={x:2,y:.1,width:.2,height:.3};
    const data=kind==='person'?{tracks:[{...track,displayBoxes:{person:invalid}}]}:{tracks:[],objects:[
      {id:'O1',kind:'phone',box:track.box,confidence:.8,observedAt:1000,trackedAt:1000,trackingState:'visual',displayBox:invalid}]};
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(data)));
    await expect(detector.detect({videoWidth:640,videoHeight:480} as HTMLVideoElement)).rejects.toMatchObject({status:502});
    detector.dispose();
  });
  it('applies saved settings before the next frame and sends them again on session reset',async()=>{
    const defaults={enabled:{head_down:true},thresholds:{headDownMs:700,headDownPitchDeg:18}};
    const schema={defaults,behaviors:[{id:'head_down',label:'Cúi đầu',description:'Góc cúi'}],fields:[
      {key:'headDownMs',group:'head_down',label:'Thời gian',value:700,min:100,max:30000,step:100,scale:1000,unit:'giây'},
      {key:'headDownPitchDeg',group:'head_down',label:'Góc',value:18,min:5,max:60,step:1,scale:1,unit:'°'}]};
    const calls:{path:string;options?:RequestInit}[]=[];
    vi.stubGlobal('fetch',vi.fn(async(path:string,options?:RequestInit)=>{
      calls.push({path,options});
      if(path==='/api/observation-settings')return new Response(JSON.stringify(schema));
      if(path==='/api/sessions')return new Response(JSON.stringify({sessionId:'session-'+(++sessionNumber)}));
      if(options?.method==='DELETE')return new Response(null,{status:204});
      if(options?.method==='PUT')return new Response(JSON.stringify({settings:JSON.parse(options.body as string)}));
      return new Response(JSON.stringify({tracks:[]}));
    }));
    const detector=await createDetector();
    const custom={enabled:{head_down:false},thresholds:{headDownMs:200,headDownPitchDeg:30}};
    saveDetectionSettings(custom);
    await detector.detect({videoWidth:640,videoHeight:480} as HTMLVideoElement);
    const applied=calls.findIndex(call=>call.options?.method==='PUT'),frame=calls.findIndex(call=>call.path.endsWith('/detect'));
    expect(applied).toBeGreaterThan(-1);expect(applied).toBeLessThan(frame);
    expect(JSON.parse(calls[applied].options!.body as string)).toEqual(custom);
    await detector.detect({videoWidth:640,videoHeight:480} as HTMLVideoElement);
    expect(calls.filter(call=>call.options?.method==='PUT')).toHaveLength(1);
    detector.reset?.();await detector.detect({videoWidth:640,videoHeight:480} as HTMLVideoElement);
    expect(JSON.parse(calls.filter(call=>call.path==='/api/sessions').at(-1)!.options!.body as string)).toEqual({settings:custom});
    detector.dispose();
  });
  it('keeps independently tracked USB objects even when no face is returned',async()=>{
    const detector=await createDetector();
    const object={id:'O1',kind:'phone',box:{x:.6,y:.3,width:.1,height:.2},confidence:.8,
      observedAt:1000,trackedAt:3500,trackingState:'visual',interaction:false};
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({tracks:[],objects:[object]})));
    expect(await detector.detect({videoWidth:640,videoHeight:480} as HTMLVideoElement)).toEqual([]);
    expect(detector.objects).toEqual([object]);
    detector.reset?.();expect(detector.objects).toEqual([]);
    detector.dispose();
  });
  it('rejects duplicate object IDs before they can reuse one SVG rectangle',async()=>{
    const detector=await createDetector();
    const object={id:'O1',kind:'phone',box:{x:.6,y:.3,width:.1,height:.2},confidence:.8,
      observedAt:1000,trackedAt:3500,trackingState:'visual'};
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({tracks:[],objects:[object,object]})));
    await expect(detector.detect({videoWidth:640,videoHeight:480} as HTMLVideoElement)).rejects.toMatchObject({status:502});
    detector.dispose();
  });
  it('preserves owner-associated object coordinates and book context from the backend', async () => {
    const detector=await createDetector('raspberry-pi');
    const objects=[{kind:'book',box:{x:.2,y:.6,width:.3,height:.2},confidence:.9,observedAt:1000}];
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({tracks:[{
      id:'A',displayName:'A',status:'visible',box:{x:.2,y:.1,width:.1,height:.2},studyContext:'book',objects,
    }]})));
    const [track]=await detector.detect(null);
    expect(track.objects).toEqual(objects);
    expect(track.studyContext).toBe('book');
    detector.dispose();
  });
  it('rejects malformed object boxes instead of painting them on the video', async () => {
    const detector=await createDetector('raspberry-pi');
    for(const object of [
      {kind:'book',box:{x:2,y:.6,width:.3,height:.2},confidence:.9,observedAt:1000},
      {kind:'unsupported',box:{x:.2,y:.6,width:.3,height:.2},confidence:.9,observedAt:1000},
    ]){
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({tracks:[{
        id:'A',displayName:'A',status:'visible',box:{x:.2,y:.1,width:.1,height:.2},objects:[object],
      }]})));
      await expect(detector.detect(null)).rejects.toMatchObject({status:502});
    }
    detector.dispose();
  });
  it('captures each fresh frame on demand without prefetching an inference-old snapshot',async()=>{
    vi.stubGlobal('Worker',class{terminate=vi.fn();});
    vi.stubGlobal('OffscreenCanvas',class{constructor(public width:number,public height:number){}});
    vi.stubGlobal('createImageBitmap',vi.fn());
    const bitmaps:ImageBitmap[]=[];
    const encode=vi.spyOn(FrameEncoder.prototype,'encode').mockImplementation(async(_source,width,height)=>{
      const bitmap={width,height,close:vi.fn()} as unknown as ImageBitmap;
      bitmaps.push(bitmap);return {image:new Blob(['jpeg']),bitmap};
    });
    const detector=await createDetector();
    const video={videoWidth:1280,videoHeight:720} as HTMLVideoElement;
    const target=document.createElement('canvas');
    await detector.detect(video);await detector.detect(video);
    expect(encode).toHaveBeenCalledTimes(2);
    detector.paintFrame?.(target);
    expect(drawImage).toHaveBeenLastCalledWith(bitmaps[1],0,0);
    await detector.detect(video);
    expect(encode).toHaveBeenCalledTimes(3);
    detector.paintFrame?.(target);
    expect(drawImage).toHaveBeenLastCalledWith(bitmaps[2],0,0);
    detector.dispose();await Promise.resolve();
    expect(bitmaps.every(bitmap=>vi.mocked(bitmap.close).mock.calls.length>=1)).toBe(true);
  });
  it('keeps full detail for a small face even when its person box is large',async()=>{
    const detector=await createDetector();
    const video={videoWidth:1920,videoHeight:1080} as HTMLVideoElement;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({tracks:[{
      id:'A',displayName:'A',status:'visible',boxKind:'person',box:{x:.1,y:.1,width:.6,height:.8},
      personBox:{x:.1,y:.1,width:.6,height:.8},faceBox:{x:.3,y:.2,width:.03,height:.05},faceVisibility:'visible',
    }]})));
    await detector.detect(video);await detector.detect(video);
    expect(drawImage).toHaveBeenLastCalledWith(video,0,0,1920,1080);
    detector.dispose();
  });
  it('restores full search detail when a previously large face disappears but its body remains visible',async()=>{
    const detector=await createDetector();
    const video={videoWidth:1920,videoHeight:1080} as HTMLVideoElement;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({tracks:[{
      id:'A',displayName:'A',status:'visible',boxKind:'person',box:{x:.1,y:.1,width:.6,height:.8},
      personBox:{x:.1,y:.1,width:.6,height:.8},faceBox:{x:.3,y:.2,width:.2,height:.3},faceVisibility:'visible',
    }]})));
    await detector.detect(video);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({tracks:[{
      id:'A',displayName:'A',status:'visible',boxKind:'person',box:{x:.1,y:.1,width:.6,height:.8},
      personBox:{x:.1,y:.1,width:.6,height:.8},faceVisibility:'unavailable',
    }]})));
    await detector.detect(video);
    expect(drawImage).toHaveBeenLastCalledWith(video,0,0,1280,720);
    await detector.detect(video);
    expect(drawImage).toHaveBeenLastCalledWith(video,0,0,1920,1080);
    detector.dispose();
  });
  it('uses 720p for a few large faces and restores full detail after reset or small-face results', async () => {
    const detector=await createDetector();
    const video={videoWidth:1920,videoHeight:1080} as HTMLVideoElement;
    await detector.detect(video);
    expect(drawImage).toHaveBeenLastCalledWith(video,0,0,1920,1080);
    await detector.detect(video);
    expect(drawImage).toHaveBeenLastCalledWith(video,0,0,1280,720);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({tracks:[{
      id:'A',displayName:'A',status:'visible',box:{x:.1,y:.2,width:.03,height:.05},
    }]})));
    await detector.detect(video);
    await detector.detect(video);
    expect(drawImage).toHaveBeenLastCalledWith(video,0,0,1920,1080);
    detector.reset?.();
    await detector.detect(video);
    expect(drawImage).toHaveBeenLastCalledWith(video,0,0,1920,1080);
    detector.dispose();
  });
  it('pairs the displayed Pi image with uploaded inference rather than a newer backend frame', async () => {
    const detector=await createDetector('raspberry-pi');
    const image=document.createElement('img');
    Object.defineProperties(image,{naturalWidth:{value:1280},naturalHeight:{value:720}});
    const target=document.createElement('canvas');
    expect(detector.paintFrame?.(target)).toBe(false);
    await detector.detect(null,image);
    expect(drawImage).toHaveBeenCalledWith(image,0,0,1280,720);
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session-1/detect',expect.objectContaining({body:expect.any(Blob)}));
    expect(detector.paintFrame?.(target)).toBe(true);
    expect([target.width,target.height]).toEqual([1280,720]);
    expect(drawImage).toHaveBeenLastCalledWith(expect.any(HTMLCanvasElement),0,0);
    detector.dispose();
    expect(detector.paintFrame?.(target)).toBe(false);
  });
  it('cannot paint an image before a valid response for that image arrives', async () => {
    const detector=await createDetector();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({tracks:null})));
    await expect(detector.detect({videoWidth:640,videoHeight:360} as HTMLVideoElement)).rejects.toMatchObject({status:502});
    expect(detector.paintFrame?.(document.createElement('canvas'))).toBe(false);
    detector.dispose();
  });
  it('maps the actual Pi frame age into browser time instead of treating an old frame as newly captured', async () => {
    const detector=await createDetector('raspberry-pi');
    const now=vi.spyOn(performance,'now').mockReturnValue(1000);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({frameAgeMs:240,tracks:[{
      id:'A',displayName:'A',status:'visible',box:{x:.1,y:.2,width:.2,height:.3},
    }]})));
    expect((await detector.detect(null))[0].frameTime).toBe(760);
    expect(detector.frameTime).toBe(760);
    detector.reset?.();
    expect(detector.frameTime).toBeUndefined();
    now.mockRestore();detector.dispose();
  });
  it('handles a null JSON error payload without losing its HTTP status', async () => {
    const detector = await createDetector('raspberry-pi');
    vi.mocked(fetch).mockResolvedValueOnce(new Response('null', { status: 503 }));
    await expect(detector.detect(null)).rejects.toMatchObject({ status: 503 });
    detector.dispose();
  });
  it.each([
    {}, { tracks: null }, { tracks: [{ id: 'A', box: { x: null, y: .2, width: .1, height: .1 } }] },
  ])('rejects malformed inference data before it can reach the renderer: %j', async data => {
    const detector = await createDetector('raspberry-pi');
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(data)));
    await expect(detector.detect(null)).rejects.toMatchObject({ status: 502 });
    detector.dispose();
  });
  it('preserves an expired-session status so the camera controller can recover', async () => {
    const detector = await createDetector('raspberry-pi');
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Phiên đã kết thúc' }), { status: 410 }));
    await expect(detector.detect(null)).rejects.toMatchObject({ status: 410, message: 'Phiên đã kết thúc' });
    detector.dispose();
  });
  it('posts a resized JPEG and uses the tracks produced by the server', async () => {
    const detector = await createDetector();
    const video = { videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement;
    const tracks = await detector.detect(video);
    expect(tracks[0].id).toBe('A');
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720);
    expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledWith(expect.any(Function),'image/jpeg',.84);
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session-1/detect', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: expect.any(Blob),
    }));
    detector.dispose();
  });
  it('asks backend to analyze the Pi frame without using the local webcam', async () => {
    const detector = await createDetector('raspberry-pi');
    await detector.detect(null);
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session-1/detect/pi', expect.objectContaining({ method: 'POST' }));
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
    detector.dispose();
  });
  it('preserves a held alert independently of the current clear signal', async () => {
    const detector = await createDetector('raspberry-pi');
    const alert = { type: 'laptop', label: 'Tương tác laptop', observedAt: 1500, expiresAt: 6500, held: true };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ tracks: [{
      id: 'A', displayName: 'A', status: 'visible', attention: 'needs_attention',
      box: { x: .1, y: .2, width: .2, height: .3 }, alerts: [alert],
      signals: [{ type: 'laptop', label: alert.label, state: 'clear', durationMs: 0 }],
    }] })));
    const [track] = await detector.detect(null);
    expect(track.alerts).toEqual([alert]);
    expect(track.signals?.[0].state).toBe('clear');
    detector.dispose();
  });
  it('rotates the server session on reset, then releases it on dispose', async () => {
    const detector = await createDetector('raspberry-pi');
    detector.reset?.();
    await detector.detect(null);
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session-1', expect.objectContaining({ method: 'DELETE' }));
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session-2/detect/pi', expect.anything());
    detector.dispose();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session-2', expect.objectContaining({ method: 'DELETE' }));
  });
  it.each(['head_turning','head_turned','torso_turned','turned_smiling','upper_body_slumped'])('accepts %s on a person whose face is unavailable', async type => {
    const detector=await createDetector('raspberry-pi');
    const alert={type,label:'Cảnh báo tư thế',observedAt:1500,expiresAt:6500,held:false};
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({tracks:[{
      id:'A',displayName:'A',status:'visible',faceVisibility:'unavailable',attention:'needs_attention',
      box:{x:.1,y:.1,width:.3,height:.7},alerts:[alert],
      signals:[{type,label:alert.label,state:'confirmed',durationMs:1500,cycles:3}],
      calibration:{state:'ready',headingReady:true,postureReady:true,startedAt:0,expiresAt:20000},
    }]})));
    const [track]=await detector.detect(null);
    expect(track.faceVisibility).toBe('unavailable');expect(track.alerts).toEqual([alert]);
    expect(track.calibration?.headingReady).toBe(true);
    detector.dispose();
  });
});
