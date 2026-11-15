// JPEG work runs away from the UI/rendering idle queue. No models or camera
// access here: only a transferred snapshot, returned with its encoded image.
let canvas:OffscreenCanvas|null=null;
onmessage=async(event:MessageEvent<{id:number;bitmap:ImageBitmap}>)=>{
  const {id,bitmap}=event.data;
  try{
    if(!canvas)canvas=new OffscreenCanvas(bitmap.width,bitmap.height);
    if(canvas.width!==bitmap.width)canvas.width=bitmap.width;
    if(canvas.height!==bitmap.height)canvas.height=bitmap.height;
    const context=canvas.getContext('2d');
    if(!context)throw new Error('Camera image encoder unavailable');
    context.drawImage(bitmap,0,0);
    const image=await canvas.convertToBlob({type:'image/jpeg',quality:.84});
    postMessage({id,image,bitmap},{transfer:[bitmap]});
  }catch(error){
    bitmap.close();
    postMessage({id,error:error instanceof Error?error.message:String(error)});
  }
};
