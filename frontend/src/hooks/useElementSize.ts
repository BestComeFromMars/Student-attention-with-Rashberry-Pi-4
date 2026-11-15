import { useLayoutEffect, useRef, useState } from 'react';

export interface ElementSize {width:number;height:number;}

export function useElementSize<T extends HTMLElement>(provided?:ElementSize) {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const shared=provided!==undefined;
  useLayoutEffect(() => {
    if(shared)return;
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    update();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(update);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [shared]);
  return { ref, ...(provided??size) };
}
