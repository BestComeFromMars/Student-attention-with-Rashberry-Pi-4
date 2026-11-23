import {memo} from 'react';
import type {ObservationSession} from '../lib/session';

/** Native playback has no dependency on AI responses, boxes or sampling rate. */
export default memo(function CameraPreview({session,on,pi,version,playback}:{
  session:ObservationSession;on:boolean;pi:boolean;version?:number;playback?:boolean;
}){
  return <>
    <video ref={session.attachVideo} muted playsInline autoPlay
      aria-label={playback?'Video lớp học':'Video trực tiếp từ webcam'} className={on&&!pi?'':'media-hidden'}
      onTimeUpdate={playback?session.playbackTimeUpdate:undefined}
      onEnded={playback?session.playbackFinished:undefined} onError={playback?session.playbackError:undefined}/>
    {on&&pi&&<img ref={session.attachPiImage} key={version} className="pi-video" src={'/api/pi/stream?v='+(version??0)}
      onError={()=>session.piStreamError()} alt="Video trực tiếp từ Raspberry Pi 4"/>}
  </>;
});
