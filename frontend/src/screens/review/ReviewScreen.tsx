import { useMemo } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { useT } from '../../i18n';
import { useAppStore, useReviewBorehole } from '../../store/appStore';
import { FieldList } from './FieldList';
import { ReviewHeader } from './ReviewHeader';
import styles from './ReviewScreen.module.css';
import { ScanPane } from './ScanPane';
import { useReviewKeys } from './useReviewKeys';
import { reviewRows, rowKeys } from './reviewView';
import type { Borehole } from '../../domain/types';

/**
 * Extraction review (prototype template lines 125–186): check every extracted value against the
 * scanned source, fix it, approve it. Left: the page with value boxes. Right: the grouped field list.
 */
export function ReviewScreen() {
  const t = useT();
  const b = useReviewBorehole();
  const go = useAppStore((s) => s.go);
  if (!b) {
    return (
      <EmptyState
        title={t('NOTHING TO REVIEW')}
        message={t('No report is ready for review yet. Upload one and wait until it reaches “needs review”.')}
        action={{ label: t('OPEN UPLOAD & QUEUE'), onClick: () => go('queue') }}
      />
    );
  }
  return <Review b={b} />;
}

function Review({ b }: { b: Borehole }) {
  const keys = useMemo(() => rowKeys(reviewRows(b)), [b]);
  useReviewKeys(keys);
  return (
    <div className={styles.screen} data-screen-label="Extraction review">
      <ReviewHeader b={b} />
      <div className={styles.body}>
        <ScanPane b={b} />
        <FieldList b={b} />
      </div>
    </div>
  );
}
