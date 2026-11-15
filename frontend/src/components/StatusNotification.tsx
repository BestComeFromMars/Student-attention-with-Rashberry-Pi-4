import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';

export default function StatusNotification({ variant, title, message, hidden = false, onClose }: {
  variant: 'error' | 'success';
  title: string;
  message: string;
  hidden?: boolean;
  onClose?: () => void;
}) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (variant !== 'success') return;
    const timer = setTimeout(() => setVisible(false), 5000);
    return () => clearTimeout(timer);
  }, [variant]);

  if (!visible || hidden) return null;

  return <div className={'status-notification status-notification--' + variant}
    role={variant === 'error' ? 'alert' : 'status'} aria-atomic="true">
    {variant === 'error' ? <CircleAlert size={22} /> : <CircleCheck size={22} />}
    <div className="status-notification-content">
      <strong>{title}</strong>
      <p>{message}</p>
    </div>
    <button type="button" aria-label="Đóng thông báo" onClick={() => {
      setVisible(false);
      onClose?.();
    }}><X size={18} /></button>
  </div>;
}
