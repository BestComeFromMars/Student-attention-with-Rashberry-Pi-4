import {FrameEncoder} from './frame-encoder';
import type {Box} from './types';

export interface GeometryFrame {frameId:number;boxes:{key:string;box:Box}[];processingMs:number;discarded?:boolean}
export interface CameraFrame extends GeometryFrame {image:ImageBitmap;capturedAt:number;mediaTime:number}

/** One immutable image owns one geometry result and one presentation commit.
 * Four bounded requests hide transport jitter; semantic work never joins them.
 */
export class PixelCamera {
  private encoder=new FrameEncoder();
  private active=true;
  private presented=0;
  private inFlight=0;
  private latest:{image:ImageBitmap;id:number;at:number}|null=null;
  private callback=0;
  private raf=0;
  private controller=new AbortController();
  private resolveReady!:(ready:boolean)=>void;
  private ready=new Promise<boolean>(resolve=>{this.resolveReady=resolve;});
  constructor(private endpoint:()=>Promise<string>,private video:HTMLVideoElement|null,
    private image:HTMLImageElement|null,private present:(frame:CameraFrame|null)=>void,
    private nextFrame:()=>number){}

  async snapshot(){
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const ready=await Promise.race([this.ready,new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),2000);})]);
      if(!ready)throw Object.assign(new Error('Chưa nhận được hình từ luồng bám camera.'),{status:503});
    }finally{clearTimeout(timer);}
    const slot=this.latest;
    if(!slot)throw new Error('Chưa có khung hình để phân tích.');
    const image=await createImageBitmap(slot.image);
    return {image,id:slot.id,at:slot.at};
  }

  async start(){
    await this.capture();
    const next=()=>{
      if(!this.active)return;
      if(this.video&&typeof this.video.requestVideoFrameCallback==='function'){
        this.callback=this.video.requestVideoFrameCallback(()=>{this.callback=0;void this.capture();next();});
      }else this.raf=requestAnimationFrame(()=>{void this.capture();next();});
    };
    next();
  }

  private async capture(){
    const source=this.image??this.video;
    const width=this.image?.naturalWidth??this.video?.videoWidth;
    const height=this.image?.naturalHeight??this.video?.videoHeight;
    if(!this.active||this.inFlight>=4||!source||!width||!height)return;
    this.inFlight++;
    const frameId=this.nextFrame(),capturedAt=performance.now(),mediaTime=this.video?.currentTime??0;
    let bitmap:ImageBitmap|null=null;
    try{
      bitmap=await createImageBitmap(source);
      if(!this.active){bitmap.close();return;}
      const scale=Math.min(1,640/Math.max(width,height));
      const encoded=await this.encoder.encode(bitmap,Math.round(width*scale),Math.round(height*scale));
      encoded.bitmap.close();
      const endpoint=await this.endpoint();
      const response=await fetch(endpoint+'/track',{method:'POST',body:encoded.image,
        headers:{'Content-Type':'image/jpeg','X-Frame-Id':String(frameId),'X-Frame-Captured-At':String(capturedAt)},
        signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(2000)])});
      if(!response.ok)throw new Error('Bám hình ảnh thất bại: '+response.status);
      const result=await response.json() as GeometryFrame;
      if(result.frameId!==frameId||!Array.isArray(result.boxes))throw new Error('Sai khung hình bám ảnh.');
      if(!this.active||result.discarded||frameId<=this.presented){bitmap.close();return;}
      this.presented=frameId;
      const previous=this.latest;
      this.latest={image:bitmap,id:frameId,at:capturedAt};
      this.resolveReady(true);
      this.present({...result,image:bitmap,capturedAt,mediaTime});
      previous?.image.close();bitmap=null;
    }catch{
      bitmap?.close();
      if(this.active)this.present(null);
    }finally{this.inFlight--;}
  }

  stop(){
    if(!this.active)return;this.active=false;this.controller.abort();this.resolveReady(false);
    if(this.callback)this.video?.cancelVideoFrameCallback(this.callback);
    cancelAnimationFrame(this.raf);this.encoder.dispose();this.latest?.image.close();this.latest=null;
    this.present(null);
  }
}
