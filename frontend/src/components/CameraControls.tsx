import { Camera, CameraOff, LoaderCircle, Pause, Play, Power } from 'lucide-react';
import { PI_DEVICE } from '../lib/types';
import type { PiStatus } from '../lib/types';
import type { ObservationSession, SessionSnapshot } from '../lib/session';
import CameraSourceSelect from './CameraSourceSelect';
import DetectionSettings from './DetectionSettings';

export default function CameraControls({ state, session, aiReady, pi }: {
  state: SessionSnapshot;
  session: ObservationSession;
  aiReady: boolean;
  pi: PiStatus | null;
}) {
  const piSource = state.selectedDevice === PI_DEVICE;
  const cameraOn = state.camera === 'on';
  const requesting = state.camera === 'requesting';
  const running = state.detection === 'running';
  const loading = state.detection === 'loading';
  const piFound = Boolean(pi?.deviceOnline && !['shutting_down', 'offline'].includes(pi.state));
  const cameraLabel = requesting ? 'Hủy kết nối' : state.playback ? 'Tắt video' : cameraOn ? 'Tắt camera' : 'Bật camera';
  const detectionLabel = state.playback ? running ? 'Tạm dừng video' : loading ? 'Đang mở video…' :
    state.playbackEnded ? 'Phát lại video' : 'Tiếp tục video' : running ? 'Tạm dừng nhận diện' : loading ? 'Đang kết nối…'
    : state.detection === 'paused' ? 'Tiếp tục nhận diện' : 'Bắt đầu nhận diện';
  const remaining=state.piShutdownRemaining;
  const shutdownSafe=Boolean(state.piShuttingDown&&remaining===0&&state.piShutdownOffline);
  const powerAriaLabel=!state.piShuttingDown?'Tắt Raspberry Pi':remaining===undefined?'Đang gửi lệnh tắt…':remaining>0?`Pi đang tắt · ${remaining}s`:
    state.piShutdownOffline?'An toàn rút điện':'Đang kiểm tra Pi…';
  const powerText=!state.piShuttingDown?null:remaining===undefined?'Đang tắt…':remaining>0?`${remaining}s`:
    state.piShutdownOffline?'An toàn rút điện':'Đang tắt…';
  const powerTitle=state.piShuttingDown
    ?remaining!==undefined&&remaining>0?`Đang tắt Raspberry Pi — chờ ${remaining} giây để an toàn rút điện`
      :shutdownSafe?'Raspberry Pi đã tắt hoàn toàn — an toàn rút điện'
      :'Đang kiểm tra trạng thái tắt của Raspberry Pi'
    :piFound?'Tắt hoàn toàn Raspberry Pi; cần rút/cắm nguồn để bật lại':'Chưa tìm thấy Raspberry Pi';

  return <nav className="camera-controls" aria-label="Điều khiển camera">
    <CameraSourceSelect value={state.selectedDevice} disabled={requesting}
      devices={state.devices} cameraLabel={state.cameraLabel}
      computerReady={!piSource && cameraOn || state.devices.length > 0}
      discovering={state.discoveringDevices} discoveryMessage={state.deviceDiscoveryMessage}
      needsRefresh={state.devicesNeedRefresh} onDiscover={() => void session.discoverDevices()}
      piReady={piFound && !state.piShuttingDown} onChange={value => void session.selectCamera(value)} />
    <button className={'control-button camera-toggle ' + (cameraOn ? 'button-outline' : 'button-blue')}
      disabled={!state.playback && piSource && Boolean(state.piShuttingDown || state.piStopping)}
      aria-label={cameraLabel} title={cameraLabel}
      onClick={() => state.camera === 'off' ? void session.startCamera() : session.stopCamera()}>
      {requesting ? <LoaderCircle size={16} className="spin" /> : cameraOn ? <CameraOff size={16} /> : <Camera size={16} />}
      <span className="control-label">{cameraLabel}</span>
      <span className="compact-label" aria-hidden="true">{requesting?'Hủy nối':state.playback?'Tắt video':cameraOn?'Tắt cam':'Bật cam'}</span>
    </button>
    <button className={'control-button detection-toggle ' + (running ? 'button-outline' : 'button-blue')}
      disabled={!cameraOn || loading || (!state.playback && !running && !aiReady)}
      aria-label={detectionLabel} title={detectionLabel}
      onClick={() => running ? session.pauseDetection() : void session.startDetection()}>
      {loading ? <LoaderCircle size={15} className="spin" /> : running ? <Pause size={15} /> : <Play size={14} fill="currentColor" />}
      <span className="control-label">{detectionLabel}</span>
      <span className="compact-label" aria-hidden="true">{running?'Tạm dừng':loading?'Đang nối':state.playbackEnded?'Phát lại':state.detection==='paused'?'Tiếp tục':'Nhận diện'}</span>
    </button>
    <DetectionSettings/>
    <button className={'control-button button-outline pi-power ' + (powerText ? 'pi-power-countdown ' : 'pi-power-icon ') + (shutdownSafe ? 'pi-power-safe' : '')}
      disabled={!piFound || Boolean(state.piShuttingDown)}
      aria-label={powerAriaLabel}
      title={powerTitle}
      onClick={() => {
        if (window.confirm('Tắt hoàn toàn Raspberry Pi? Bạn cần rút và cắm lại nguồn để bật Pi.')) void session.shutdownPi();
      }}><Power size={16} />{powerText && <span className="pi-power-status">{powerText}</span>}
    </button>
  </nav>;
}
