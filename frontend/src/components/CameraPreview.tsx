import {memo} from 'react';
import type {ObservationSession} from '../lib/session';

/** Native playback has no dependency on AI responses, boxes or sampling rate. */
export default memo(function CameraPreview({session,on,pi,version}:{
  session:ObservationSession;on:boolean;pi:boolean;version?:number;
}){
  return <>
    <video ref={session.attachVideo} muted playsInline autoPlay aria-label="Video trực tiếp từ webcam" className={on&&!pi?'':'media-hidden'}/>
    {on&&pi&&<img ref={session.attachPiImage} key={version} className="pi-video" src={'/api/pi/stream?v='+(version??0)}
      onError={()=>session.piStreamError()} alt="Video trực tiếp từ Raspberry Pi 4"/>}
  </>;
});
