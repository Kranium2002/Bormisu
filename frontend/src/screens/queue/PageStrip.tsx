import type { MouseEvent } from 'react';
import type { DocumentSummary } from '../../domain/types';
import { useAppStore } from '../../store/appStore';
import { PAGE_TYPE_META } from '../../theme';
import { canOpenPage, pageTitle } from './queueView';
import styles from './PageStrip.module.css';

/** Page map of a document: click a classified page to open it in the Source panel. Read-only. */
export function PageStrip({ doc }: { doc: DocumentSummary }) {
  const openPage = useAppStore((s) => s.openPage);
  const shownPage = useAppStore((s) =>
    s.panel?.kind === 'source' && s.panel.documentId === doc.id ? s.panel.page : null,
  );

  return (
    <div className={styles.strip} role="group" aria-label={`Page map of ${doc.name}`}>
      {doc.pageTypes.map((type, i) => {
        const page = i + 1;
        const meta = PAGE_TYPE_META[type];
        const title = pageTitle(type, page);
        const openable = canOpenPage(type);
        const onClick = (e: MouseEvent) => {
          // The card behind opens Review; a page click only opens the page (or nothing, if unclassified).
          e.stopPropagation();
          if (openable) openPage(doc.id, page);
        };
        return (
          <button
            key={page}
            type="button"
            className={`${styles.cell} ${shownPage === page ? styles.current : ''}`}
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
