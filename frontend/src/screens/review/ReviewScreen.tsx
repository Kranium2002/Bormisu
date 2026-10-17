import { useMemo } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { isReviewable, useAppStore, useReviewBorehole } from '../../store/appStore';
import { FieldList } from './FieldList';
import { ReviewHeader } from './ReviewHeader';
import styles from './ReviewScreen.module.css';
import { ScanPane } from './ScanPane';
import { useReviewKeys } from './useReviewKeys';
import { emptyReview, reviewRows, rowKeys } from './reviewView';
import type { Borehole } from '../../domain/types';

/**
 * Extraction review (prototype template lines 125–186): check every extracted value against the
 * scanned source, fix it, approve it. Left: the page with value boxes. Right: the grouped field list.
 */
export function ReviewScreen() {
  const b = useReviewBorehole();
  const go = useAppStore((s) => s.go);
  const hasBoreholes = useAppStore((s) => s.boreholes.length > 0);
  const anyReviewable = useAppStore((s) => s.boreholes.some(isReviewable));
  if (!b) {
    const empty = emptyReview(hasBoreholes, anyReviewable);
    return (
      <EmptyState
        title="NOTHING TO REVIEW"
        message={empty.message}
        action={{ label: empty.action.label, onClick: () => go(empty.action.screen) }}
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
