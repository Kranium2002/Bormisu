import { useState, type MouseEvent } from 'react';
import type { DocumentSummary } from '../../domain/types';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/appStore';
import { retryBlockedReason } from '../../store/uploads';
import styles from './DocumentWarnings.module.css';
import { canRetryWarnings } from './queueView';

interface Props {
  doc: DocumentSummary;
  /** 'card' inside a queue card, 'banner' across the Review screen. */
  variant: 'card' | 'banner';
}

/**
 * A document's warnings (contract 1.2.1, e.g. "Page 1 was not read; boreholes on it are missing.
 * Retry the document to read it."), shown as the server wrote them, with RETRY, which reads the
 * missing pages again. RETRY is off with the reason in demo mode; the server's answer to a refused
 * retry (409 not_failed, demo_mode) comes back as a readable toast. Nothing without warnings.
 */
export function DocumentWarnings({ doc, variant }: Props) {
  const t = useT();
  const retryDocument = useAppStore((s) => s.retryDocument);
  const blocked = useAppStore((s) => retryBlockedReason(s.health));
  const [retrying, setRetrying] = useState(false);
  if (!doc.warnings?.length) return null;
  const retryable = canRetryWarnings(doc);
  const off = blocked ? t(blocked) : null;

  const onRetry = async (e: MouseEvent) => {
    e.stopPropagation();
    setRetrying(true);
    try {
      await retryDocument(doc.id);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className={variant === 'banner' ? styles.banner : styles.box} role="note" aria-label={t('Document warnings')}>
      <span className={styles.icon} aria-hidden="true">
        ⚠
      </span>
      <ul className={styles.list}>
        {doc.warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
      {retryable && (
        <button
          type="button"
          className={styles.retry}
          disabled={retrying || !!off}
          title={off ?? (retrying ? t('Re-queuing…') : t('Read the missing pages again'))}
          aria-description={off ?? undefined}
          onClick={(e) => void onRetry(e)}
        >
          {retrying ? t('RETRYING…') : t('RETRY')}
        </button>
      )}
    </div>
  );
}
