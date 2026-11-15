import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

/** Keep an exiting surface briefly, but remove it from keyboard/accessibility immediately. */
export default function AnimatedPresence({ show, className, children, keepMounted = false }: {
  show: boolean; className: string; children: ReactNode; keepMounted?: boolean;
}) {
  const [mounted, setMounted] = useState(show);
  useEffect(() => {
    if (show) { setMounted(true); return; }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = setTimeout(() => setMounted(false), reduced ? 0 : 220);
    return () => clearTimeout(timer);
  }, [show]);
  if (!show && !mounted && !keepMounted) return null;
  return <div className={className + ' motion-presence'} data-visible={show} aria-hidden={!show} inert={!show}>
    {children}
  </div>;
}
