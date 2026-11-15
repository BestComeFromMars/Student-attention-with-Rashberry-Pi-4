import { Focus } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useObservation } from './hooks/useObservation';
import ObservationView from './components/ObservationView';
import { useBackendHealth } from './hooks/useBackendHealth';
import StatusNotification from './components/StatusNotification';
import { usePiStatus } from './hooks/usePiStatus';
import { useElementSize } from './hooks/useElementSize';
import CameraControls from './components/CameraControls';

export default function App() {
  const { session, state } = useObservation();
  const { state: health } = useBackendHealth();

  const pi = usePiStatus();
  const toolbar = useElementSize<HTMLElement>();

  return (
    <div className="app-shell" style={{ '--toolbar-height': toolbar.height + 'px' } as CSSProperties}>
      <header ref={toolbar.ref} className="app-header">
        <a className="brand" href="/" aria-label="Student Attention">
          <span className="brand-symbol"><Focus size={23} strokeWidth={2} /></span>
          <span>Student<span className="brand-blue">Attention</span><span className="brand-subtitle">Quan sát lớp học</span></span>
        </a>
        <CameraControls state={state} session={session} aiReady={health === 'ready'} pi={pi} />
      </header>
      {health === 'unavailable' && <StatusNotification
        key="backend-unavailable"
        variant="error"
        title="Chưa kết nối được backend"
        message="Hãy bật backend bằng npm start tại thư mục dự án. Ứng dụng sẽ tự kết nối lại."
        hidden={Boolean(state.error)}
      />}
      {state.error && <StatusNotification
        key={'session:' + state.error}
        variant="error"
        title="Không thể hoàn tất thao tác"
        message={state.error}
        onClose={() => session.dismissError()}
      />}
      <main className="workspace">
        <ObservationView state={state} session={session}/>
      </main>
    </div>
  );
}
