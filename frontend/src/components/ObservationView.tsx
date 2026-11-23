import {Camera,LoaderCircle,Maximize2,Minimize2} from 'lucide-react';
import type {SessionSnapshot,ObservationSession} from '../lib/session';
import {PI_DEVICE} from '../lib/types';
import {useLiveOverlays} from '../hooks/useLiveOverlays';
import PixelPreview from './PixelPreview';
import AttentionList from './AttentionList';
import {useElementSize} from '../hooks/useElementSize';
import {useCameraExpansion} from '../hooks/useCameraExpansion';
import CameraPreview from './CameraPreview';
import PlaybackOverlay from './PlaybackOverlay';

export default function ObservationView({state,session}:{state:SessionSnapshot;session:ObservationSession}){
  const nextScope=`${state.selectedDevice}:${state.trackingVersion??0}`;
  const piSource=!state.playback&&state.selectedDevice===PI_DEVICE;
  const live=useLiveOverlays(state.tracks,state.objects??[],state.detection==='running');
  const tracks=state.playback?state.tracks:live.tracks;
  const stage=useElementSize<HTMLDivElement>(),camera=useCameraExpansion();
  const cameraOn=state.camera==='on',aspect=state.resolution?state.resolution.width/state.resolution.height:16/9;
  return <div className="observation-layout">
    <section className="camera-panel" aria-label="Camera lớp học" data-expanded={camera.expanded}>
      <div className="camera-heading"><div className="camera-title-row"><h1><Camera size={19}/>Camera lớp học</h1>
        <span className="camera-person-count">{tracks.filter(track=>track.status==='visible').length}/{state.memory?.limit??40} người</span>
        {cameraOn&&!state.playback&&state.detection==='running'&&<span className="camera-ai-status" role="status">
          {state.inferenceMs===undefined?'AI đang xử lý…':
            `AI: ${state.fps.toFixed(1)} lần/s · xử lý ${(state.inferenceMs/1000).toFixed(1)} s`}
        </span>}
        <div className="camera-heading-actions">{cameraOn&&!state.playback&&<span className="camera-live-summary" aria-label="Camera đang phát trực tiếp"><i/><span>Trực tiếp</span></span>}
          <button ref={camera.button} type="button" className="camera-expand-button" aria-label={camera.expanded?'Thu nhỏ camera':'Phóng to camera'}
            aria-pressed={camera.expanded} onClick={camera.toggle}>{camera.expanded?<Minimize2 size={17}/>:<Maximize2 size={17}/>}<span>{camera.expanded?'Thu nhỏ':'Phóng to'}</span></button>
        </div></div></div>
      {cameraOn&&state.detection==='running'&&state.memory?.limited&&<div className="memory-notice" role="status"><strong>Không đủ RAM để nhận diện.</strong> Vẫn tiếp tục xử lý tối đa {state.memory.limit} người; tự tăng lại khi đủ RAM.</div>}
      <div className="camera-stage" ref={stage.ref}><div className="video-viewport" style={{aspectRatio:aspect,width:Math.min(stage.width,stage.height*aspect)}}>
        <CameraPreview session={session} on={cameraOn} pi={piSource} version={state.piStreamVersion} playback={state.playback}/>
        {cameraOn&&state.playbackOverlay&&state.resolution&&<PlaybackOverlay session={session}
          width={state.resolution.width} height={state.resolution.height}/>}
        <canvas ref={session.attachResultCanvas} className="analysis-frame" hidden aria-hidden="true"/>
        {cameraOn&&!state.playback&&state.detection==='running'&&<PixelPreview session={session} scope={nextScope}/>}
        {!cameraOn&&<div className="camera-empty"><span className="empty-camera-icon"><Camera size={40} strokeWidth={1.5}/></span>
          <h2>{state.playback?'Đang mở video':state.camera==='requesting'?'Đang kết nối camera':'Camera chưa bật'}</h2>
          {!state.playback&&<p>{piSource?state.piMessage??'Kết nối nguồn hình từ Raspberry Pi 4.':'Bật camera để bắt đầu quan sát lớp học.'}</p>}</div>}
        {state.detection==='loading'&&!state.playback&&<div className="video-message"><LoaderCircle size={16} className="spin"/>Đang kết nối nhận diện…</div>}
        {state.detection==='running'&&state.retrying&&<div className="video-message"><LoaderCircle size={16} className="spin"/>Đang thử lại khung nhận diện…</div>}
        {cameraOn&&!state.playback&&state.detection==='paused'&&<div className="video-message">Nhận diện đang tạm dừng</div>}
      </div></div>
    </section>
    <AttentionList state={state} session={session} inert={camera.expanded}/>
  </div>;
}
