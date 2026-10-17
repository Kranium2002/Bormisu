import { useState } from 'react';
import { tr } from '../i18n';
import { PAGE_H, PAGE_W, type Box, type PageContent, type PageItem } from '../domain/types';
import styles from './ScanPage.module.css';

/** How a value box is drawn on the scan (prototype review + source panel styles). */
export type ScanBoxVariant = 'focus' | 'flagged' | 'lint' | 'approved' | 'idle' | 'highlight';

export interface ScanBox {
  id: string;
  box: Box;
  variant: ScanBoxVariant;
  title?: string;
  onClick?: () => void;
}

interface Props {
  content: PageContent;
  boxes?: ScanBox[];
  /** 1 = 560 px wide (Review), 0.92 in the Source panel. */
  scale?: number;
}

function Item({ it }: { it: PageItem }) {
  if (it.kind === 'line') {
    return <div className={styles.line} style={{ left: it.x, top: it.y, width: it.w, height: it.h, background: it.color }} />;
  }
  return (
    <div className={styles.text} style={{ left: it.x, top: it.y, fontSize: it.fontSize, fontWeight: it.fontWeight, color: it.color }}>
      {it.text}
    </div>
  );
}

/** Load state of an API page image. */
export type ImageStatus = 'loading' | 'ready' | 'error';

function BoxOverlay({ b }: { b: ScanBox }) {
  const pos = { left: `${b.box.x * 100}%`, top: `${b.box.y * 100}%`, width: `${b.box.w * 100}%`, height: `${b.box.h * 100}%` };
  const cls = `${styles.box} ${styles[b.variant]}`;
  if (!b.onClick) return <div className={cls} style={pos} title={b.title} />;
  return <button type="button" className={cls} style={pos} title={b.title} aria-label={b.title} onClick={b.onClick} />;
}

/**
 * An API page image (frontend_din). Until it has loaded (and if it fails) the page keeps its 560:780
 * shape, so the boxes stay where they belong. On error a placeholder names the page and the request
 * path. ScanPage keys it by URL, so another page starts again at 'loading'.
 */
function ImagePage({ content, boxes, width }: { content: PageContent; boxes: ScanBox[]; width: number }) {
  const url = content.imageUrl ?? '';
  const [status, setStatus] = useState<ImageStatus>('loading');
  return (
    <div
      className={`${styles.page} ${styles.imagePage} ${status === 'ready' ? '' : styles.reserved}`}
      style={{ width }}
      aria-busy={status === 'loading' || undefined}
    >
      {status !== 'error' && (
        <img
          className={`${styles.image} ${status === 'loading' ? styles.imageLoading : ''}`}
          src={url}
          alt={content.label}
          onLoad={() => setStatus('ready')}
          onError={() => setStatus('error')}
        />
      )}
      {status === 'error' && (
        <div className={styles.placeholder} role="note">
          <span className={styles.placeholderTitle}>
            {tr('PAGE IMAGE NOT AVAILABLE')} · {tr('page')} {content.page}
          </span>
          <span className={styles.placeholderPath}>{url}</span>
        </div>
      )}
      {boxes.map((b) => <BoxOverlay key={b.id} b={b} />)}
    </div>
  );
}

/**
 * A scanned page: an API page image, or a sample page drawn from items in the 560×780 space.
 * Boxes are normalised (0–1), so they land in the same place on both.
 */
export function ScanPage({ content, boxes = [], scale = 1 }: Props) {
  const width = PAGE_W * scale;
  if (content.imageUrl) return <ImagePage key={content.imageUrl} content={content} boxes={boxes} width={width} />;
  return (
    <div className={styles.frame} style={{ width, height: PAGE_H * scale }}>
      <div
        className={styles.page}
        style={{ width: PAGE_W, height: PAGE_H, transform: scale === 1 ? undefined : `scale(${scale})` }}
        role="img"
        aria-label={content.label}
      >
        {(content.items ?? []).map((it, i) => <Item key={i} it={it} />)}
        {boxes.map((b) => <BoxOverlay key={b.id} b={b} />)}
      </div>
    </div>
  );
}
