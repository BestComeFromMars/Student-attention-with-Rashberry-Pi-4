import {afterEach,describe,expect,it,vi} from 'vitest';
import {FrameEncoder} from './frame-encoder';

afterEach(()=>vi.unstubAllGlobals());

function setup(){
  let worker!:FakeWorker;
  class FakeWorker{
    onmessage:((event:MessageEvent)=>void)|null=null;
    onerror:(()=>void)|null=null;
    postMessage=vi.fn();terminate=vi.fn();
    constructor(){worker=this;}
  }
  const bitmap={width:640,height:360,close:vi.fn()} as unknown as ImageBitmap;
  vi.stubGlobal('Worker',FakeWorker);
  vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue(bitmap));
  const encoder=new FrameEncoder();
  return {encoder,worker,bitmap};
}

describe('camera frame encoder ownership',()=>{
  it('crops the supplied immutable image to a 160-pixel portrait before worker encoding',async()=>{
    const {encoder,worker,bitmap}=setup(),source={} as ImageBitmap;
    const pending=encoder.encodeCrop(source,10,20,80,80);await Promise.resolve();
    expect(createImageBitmap).toHaveBeenCalledWith(source,10,20,80,80,{resizeWidth:160,resizeHeight:160,resizeQuality:'medium'});
    worker.onmessage!({data:{id:1,image:new Blob(['portrait']),bitmap}} as MessageEvent);
    (await pending).bitmap.close();encoder.dispose();
  });
  it('returns the exact snapshot paired with the JPEG and transfers ownership both ways',async()=>{
    const {encoder,worker,bitmap}=setup();
    const pending=encoder.encode({} as CanvasImageSource,640,360);
    await Promise.resolve();
    expect(worker.postMessage).toHaveBeenCalledWith({id:1,bitmap},[bitmap]);
    const image=new Blob(['jpeg']);
    worker.onmessage!({data:{id:1,image,bitmap}} as MessageEvent);
    expect(await pending).toEqual({id:1,image,bitmap});
    expect(bitmap.close).not.toHaveBeenCalled();
    encoder.dispose();expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('cancels a pending encoding and releases a late returned bitmap',async()=>{
    const {encoder,worker,bitmap}=setup();
    const pending=encoder.encode({} as CanvasImageSource,640,360);
    const rejected=expect(pending).rejects.toThrow('closed');
    await Promise.resolve();encoder.dispose();
    await rejected;
    worker.onmessage!({data:{id:1,image:new Blob(),bitmap}} as MessageEvent);
    expect(bitmap.close).toHaveBeenCalledOnce();
    encoder.dispose();expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
