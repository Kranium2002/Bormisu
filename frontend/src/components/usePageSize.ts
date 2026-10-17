/**
 * Sizes a page view needs to lay out a scanned page: the natural size of its image and the width of
 * the pane it is fitted into. Shared by the verification screen and the sheet's original-page pane.
 */
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/** Natural size of a page image, once it has loaded; null before, on error and for drawn sample pages. */
export function useImageSize(url: string | undefined): { w: number; h: number } | null {
  const [size, setSize] = useState<{ url: string; w: number; h: number } | null>(null);
  useEffect(() => {
    if (!url) return;
    const img = new Image();
    img.onload = () => setSize({ url, w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
    return () => {
      img.onload = null;
    };
  }, [url]);
  return size && size.url === url ? size : null;
}

/** Width of an element, kept up to date. */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
