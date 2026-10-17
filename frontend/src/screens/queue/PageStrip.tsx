import type { MouseEvent } from 'react';
import type { DocumentSummary } from '../../domain/types';
import { useAppStore } from '../../store/appStore';
import { pageMeta } from '../../theme';
import { canOpenPage, pageTitle } from './queueView';
import styles from './PageStrip.module.css';

/**
 * Page map of a document from its classified pages: one swatch per page by type (white while not
 * classified, neutral grey for a classified page without a type), a tooltip with what the backend
 * reported (usage, role, sheet, OCR, handwriting, duplicate). Click a classified page to open it in
 * the Source panel; unused pages are drawn faded.
 */
export function PageStrip({ doc }: { doc: DocumentSummary }) {
  const openPage = useAppStore((s) => s.openPage);
  const shownPage = useAppStore((s) =>
    s.panel?.kind === 'source' && s.panel.documentId === doc.id ? s.panel.page : null,
  );

  return (
    <div className={styles.strip} role="group" aria-label={`Page map of ${doc.name}`}>
      {doc.pages.map((p) => {
        const meta = pageMeta(p);
        const title = pageTitle(p, doc.id);
        const openable = canOpenPage(p);
        const onClick = (e: MouseEvent) => {
          // The card behind opens Review; a page click only opens the page (or nothing, if unclassified).
          e.stopPropagation();
          if (openable) openPage(doc.id, p.n);
        };
        return (
          <button
            key={p.n}
            type="button"
            className={`${styles.cell} ${shownPage === p.n ? styles.current : ''} ${p.classified && !p.used ? styles.unused : ''}`}
            style={{ background: meta.color, borderColor: meta.border }}
            title={title}
            aria-label={title}
            aria-disabled={openable ? undefined : true}
            onClick={onClick}
          />
        );
      })}
    </div>
  );
}
