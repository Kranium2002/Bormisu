import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { DocumentPage, DocumentSummary } from '../../domain/types';
import { useAppStore } from '../../store/appStore';
import { pageMeta } from '../../theme';
import { canOpenPage, pageTitle, thumbnailAlt } from './queueView';
import styles from './PageStrip.module.css';

/** Width of a page thumbnail in the strip's tooltip (px; the source scales the image to it). */
export const THUMBNAIL_WIDTH = 200;

/** The source's page thumbnail URL (DataSource.thumbnailUrl): null when it has no page images. */
export type ThumbnailUrl = (documentId: string, page: number) => string | null;

interface TipProps {
  id: string;
  page: DocumentPage;
  /** Thumbnail URL; null when the image failed to load. */
  url: string | null;
  /** What the backend reported about the page (the cell's label). */
  title: string;
  onBroken(): void;
}

/** The card above a hovered or focused page cell: the page thumbnail (lazy, 200 px wide) and the page text. */
export function PageTip({ id, page, url, title, onBroken }: TipProps) {
  return (
    <span className={styles.tip} role="tooltip" id={id}>
      {url ? (
        <img className={styles.thumb} src={url} width={THUMBNAIL_WIDTH} loading="lazy" alt={thumbnailAlt(page)} onError={onBroken} />
      ) : (
        <span className={styles.noThumb}>No page image</span>
      )}
      <span className={styles.tipText}>{title}</span>
    </span>
  );
}

/**
 * Page map of a document from its classified pages: one swatch per page by type (white while not
 * classified, neutral grey for a classified page without a type) with what the backend reported
 * (usage, role, sheet, OCR, handwriting, duplicate). When the source has page images, hovering or
 * focusing a cell shows the page thumbnail with that text; otherwise the text is the cell's tooltip.
 * Click a classified page to open it in the Source panel; unused pages are drawn faded.
 */
export function PageStrip({ doc, thumbnailUrl = null }: { doc: DocumentSummary; thumbnailUrl?: ThumbnailUrl | null }) {
  const openPage = useAppStore((s) => s.openPage);
  const shownPage = useAppStore((s) =>
    s.panel?.kind === 'source' && s.panel.documentId === doc.id ? s.panel.page : null,
  );
  /** The page whose thumbnail is shown (hover or focus); null when none. */
  const [preview, setPreview] = useState<number | null>(null);
  /** Pages whose thumbnail could not be loaded: their card shows the text only. */
  const [broken, setBroken] = useState<ReadonlySet<number>>(() => new Set());

  return (
    <div className={styles.strip} role="group" aria-label={`Page map of ${doc.name}`}>
      {doc.pages.map((p) => {
        const meta = pageMeta(p);
        const title = pageTitle(p, doc.id);
        const openable = canOpenPage(p);
        const thumb = thumbnailUrl?.(doc.id, p.n) ?? null;
        const tipId = `page-tip-${doc.id}-${p.n}`;
        const showing = thumb !== null && preview === p.n;
        const onClick = (e: MouseEvent) => {
          // The card behind opens Review; a page click only opens the page (or nothing, if unclassified).
          e.stopPropagation();
          if (openable) openPage(doc.id, p.n);
        };
        const onKeyDown = (e: KeyboardEvent) => {
          // Escape hides the thumbnail first (WCAG 1.4.13); the app's Escape handling still runs.
          if (e.key === 'Escape' && showing) setPreview(null);
        };
        const hide = () => setPreview((n) => (n === p.n ? null : n));
        return (
          <span
            key={p.n}
            className={styles.cellWrap}
            onMouseEnter={thumb ? () => setPreview(p.n) : undefined}
            onMouseLeave={thumb ? hide : undefined}
          >
            <button
              type="button"
              className={`${styles.cell} ${shownPage === p.n ? styles.current : ''} ${p.classified && !p.used ? styles.unused : ''}`}
              style={{ background: meta.color, borderColor: meta.border }}
              // Without page images the text is the native tooltip; with them, the thumbnail card shows it.
              title={thumb ? undefined : title}
              aria-label={title}
              aria-describedby={showing ? tipId : undefined}
              aria-disabled={openable ? undefined : true}
              onClick={onClick}
              onFocus={thumb ? () => setPreview(p.n) : undefined}
              onBlur={thumb ? hide : undefined}
              onKeyDown={onKeyDown}
            />
            {showing && (
              <PageTip
                id={tipId}
                page={p}
                url={broken.has(p.n) ? null : thumb}
                title={title}
                onBroken={() => setBroken((s) => new Set(s).add(p.n))}
              />
            )}
          </span>
        );
      })}
    </div>
  );
}
