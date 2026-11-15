import { Camera, Check, ChevronDown, LoaderCircle, RefreshCw, Video } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { PI_DEVICE } from '../lib/types';

export default function CameraSourceSelect({ value, disabled, computerReady, piReady, devices = [], cameraLabel,
  discovering, discoveryMessage, needsRefresh, onDiscover, onChange }: {
  value: string;
  disabled: boolean;
  computerReady: boolean;
  piReady: boolean;
  devices?: { deviceId: string; label: string }[];
  cameraLabel?: string;
  discovering?: boolean;
  discoveryMessage?: string;
  needsRefresh?: boolean;
  onDiscover?: () => void;
  onChange: (value: string) => void;
}) {
  const items = [
    { value: '', label: 'Webcam máy tính', ready: computerReady, Icon: Video },
    ...devices.filter((device,index) => device.deviceId && device.deviceId !== PI_DEVICE &&
      devices.findIndex(other => other.deviceId === device.deviceId) === index)
      .map((device,index) => ({ value: device.deviceId, label: device.label || `Camera ${index+1}`, ready: true, Icon: Video })),
    { value: PI_DEVICE, label: 'Raspberry Pi 4', ready: piReady, Icon: Camera },
  ];
  // A running camera may be absent from enumeration until permission settles.
  if (value && !items.some(item => item.value === value)) items.splice(items.length-1,0,
    { value, label: cameraLabel || 'Camera đã chọn', ready: computerReady, Icon: Video });
  const selected = Math.max(0,items.findIndex(item => item.value === value));
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(selected);
  const [position, setPosition] = useState({ left: 12, top: 52, width: 300 });

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => { setActive(selected); }, [selected, items.length]);
  useEffect(() => {
    if (open) document.getElementById(id+'-'+active)?.scrollIntoView?.({block:'nearest'});
  }, [open, active, id]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(320, window.innerWidth - 24);
      setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: rect.bottom + 6 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  const choose = (index: number) => {
    if (!items[index]) return;
    onChange(items[index].value);
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  const show = (index = selected) => { setActive(index); setOpen(true); };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open) show(event.key === 'End' ? items.length-1 : event.key === 'Home' ? 0 : selected);
      else setActive(event.key === 'Home' ? 0 : event.key === 'End' ? items.length-1 :
        (active + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length);
    } else if (event.key === 'Escape') {
      event.preventDefault(); setOpen(false);
    }
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(active);
      else show();
    }
  };
  const SelectedIcon = items[selected].Icon;
  const namedDevices = devices.some(device => device.deviceId && device.label);
  return <div ref={root} className="source-picker" onKeyDown={event => {
    if (event.key === 'Escape' && open) { setOpen(false); trigger.current?.focus(); }
  }} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <button ref={trigger} type="button" className="source-select" role="combobox" aria-label="Chọn webcam"
      aria-haspopup="listbox" aria-expanded={open} aria-controls={id} disabled={disabled} aria-describedby={id+'-status'}
      aria-activedescendant={open ? id + '-' + active : undefined} onKeyDown={keyDown}
      onClick={() => { if (open) setOpen(false); else show(); }}>
      <SelectedIcon size={16} aria-hidden="true" />
      <span className="source-selection">
        <span className="source-value">{items[selected].label}</span>
        <span id={id+'-status'} aria-live="polite" className={'source-current-status camera-status '+(items[selected].ready?'camera-status-ready':'camera-status-missing')}>
          <i />{items[selected].ready?'Sẵn sàng':'Chưa tìm thấy'}
        </span>
      </span>
      <ChevronDown size={12} aria-hidden="true" />
    </button>
    {open && <div className="source-menu"
      style={{...position, maxHeight: Math.max(80,window.innerHeight-position.top-12), overflowY:'auto'}}>
      <div id={id} role="listbox" aria-label="Nguồn camera">
      {items.map((item, index) => <button key={item.value} type="button" role="option" tabIndex={-1}
        id={id + '-' + index} aria-selected={selected === index} className={'source-option ' + (active === index ? 'source-option-active' : '')}
        onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
        <item.Icon size={16} aria-hidden="true" /><span className="source-option-label">{item.label}</span>
        <span className={'camera-status ' + (item.ready ? 'camera-status-ready' : 'camera-status-missing')}>
          <i />{item.ready ? 'Sẵn sàng' : 'Chưa tìm thấy'}
        </span><Check size={14} aria-hidden="true" className={selected === index ? '' : 'source-check-hidden'} />
      </button>)}
      </div>
      {onDiscover && <div className="source-discovery">
        {!namedDevices && <p>Bấm Làm mới danh sách và cho phép camera để hiện đầy đủ thiết bị.</p>}
        <button type="button" className="source-discover-button" disabled={discovering} onClick={onDiscover}>
          {discovering ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
          {discovering ? 'Đang tìm camera…' : 'Làm mới danh sách'}
        </button>
        <p role="status" aria-live="polite">{discovering ? 'Chọn Cho phép nếu trình duyệt hỏi quyền camera.'
          : needsRefresh ? 'Thiết bị camera đã thay đổi. Bấm Làm mới danh sách để cập nhật.' : discoveryMessage}</p>
      </div>}
    </div>}
  </div>;
}
