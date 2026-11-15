export interface EncodedFrame {image:Blob;bitmap:ImageBitmap}

export class FrameEncoder {
  private worker:Worker;
  private nextId=0;
  private closed=false;
  private pending=new Map<number,{resolve:(frame:EncodedFrame)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();

  constructor(){
    this.worker=new Worker(new URL('./frame-encoder.worker.ts',import.meta.url),{type:'module'});
    this.worker.onmessage=(event:MessageEvent<{id:number;image:Blob;bitmap:ImageBitmap;error?:string}>)=>{
      const job=this.pending.get(event.data.id);
      if(!job){event.data.bitmap?.close();return;}
      this.pending.delete(event.data.id);clearTimeout(job.timer);
      if(event.data.error)job.reject(new Error(event.data.error));
      else job.resolve(event.data);
    };
    this.worker.onerror=()=>this.dispose();
  }

  async encode(source:CanvasImageSource,width:number,height:number):Promise<EncodedFrame>{
    if(this.closed)throw new Error('Camera image encoder closed');
    const bitmap=await createImageBitmap(source,{resizeWidth:width,resizeHeight:height,resizeQuality:'low'});
    return this.encodeBitmap(bitmap);
  }

  async encodeCrop(source:CanvasImageSource,x:number,y:number,width:number,height:number):Promise<EncodedFrame>{
    if(this.closed)throw new Error('Camera image encoder closed');
    const bitmap=await createImageBitmap(source,x,y,width,height,{resizeWidth:160,resizeHeight:160,resizeQuality:'medium'});
    return this.encodeBitmap(bitmap);
  }

  private encodeBitmap(bitmap:ImageBitmap):Promise<EncodedFrame>{
    if(this.closed){bitmap.close();throw new Error('Camera image encoder closed');}
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.dispose(),5000);
      this.pending.set(id,{resolve,reject,timer});
      try{this.worker.postMessage({id,bitmap},[bitmap]);}
      catch(error){bitmap.close();this.pending.delete(id);clearTimeout(timer);reject(error);}
    });
  }

  dispose(){
    if(this.closed)return;
    this.closed=true;this.worker.terminate();
    for(const job of this.pending.values()){
      clearTimeout(job.timer);job.reject(new Error('Camera image encoder closed'));
    }
    this.pending.clear();
  }
}
