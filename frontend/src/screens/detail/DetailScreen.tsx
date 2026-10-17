import { useCallback } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { StatusChip } from '../../components/StatusChip';
import { displayStatus } from '../../domain/status';
import { useAppStore, useIsReviewable, useSelectedBorehole } from '../../store/appStore';
import { reviewedText } from './detailModel';
import { ExportMenu } from './ExportMenu';
import { GroundwaterTable } from './GroundwaterTable';
import { LayersTable } from './LayersTable';
import { MetadataCard } from './MetadataCard';
import { ProfileColumn, ProfileLegend } from './ProfileColumn';
import card from './cards.module.css';
import styles from './DetailScreen.module.css';

/**
 * Borehole detail: sticky header (breadcrumb, ID, status, OPEN IN REVIEW, EXPORT ▾), the DIN 4023
 * profile on the left, and METADATA + LOCATION, LAYERS and GROUNDWATER on the right.
 * Every value links to its source; the profile and the layer table share the selected layer.
 */
export function DetailScreen() {
  const b = useSelectedBorehole();
  const selectedLayer = useAppStore((s) => s.selectedLayer);
  const selectLayer = useAppStore((s) => s.selectLayer);
  const openSource = useAppStore((s) => s.openSource);
  const openReview = useAppStore((s) => s.openReview);
  const go = useAppStore((s) => s.go);
  const isSample = useAppStore((s) => s.source?.kind === 'sample');
  const reviewable = useIsReviewable(b?.uid);
  const uid = b?.uid;
  const onOpenSource = useCallback(
    (key: string) => {
      if (uid) openSource(uid, key);
    },
    [uid, openSource],
  );

  if (!b) {
    return (
      <EmptyState
        title="NO BOREHOLE SELECTED"
        message="Pick a borehole on the map or in the results table."
        action={{ label: 'OPEN MAP', onClick: () => go('map') }}
      />
    );
  }

  return (
    <div className={styles.screen} data-screen-label="Borehole detail">
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <nav className={styles.crumbs} aria-label="Breadcrumb">
            <button type="button" className={styles.crumbLink} onClick={() => go('map')}>
              Map
            </button>
            <span aria-hidden="true">›</span>
            <span>
              {b.project || 'Unnamed project'}
              {isSample ? ' (fictional)' : ''}
            </span>
          </nav>
          <div className={styles.titleRow}>
            <h1 className={styles.id}>{b.id}</h1>
            <StatusChip status={displayStatus(b)} size="md" />
            <span className={styles.reviewed}>{reviewedText(b)}</span>
          </div>
        </div>
        <div className={styles.spacer} />
        {reviewable && (
          <button type="button" className={styles.reviewButton} onClick={() => openReview(b.uid)}>
            › OPEN IN REVIEW
          </button>
        )}
        <ExportMenu borehole={b} />
      </header>

      <div className={styles.body}>
        <section className={card.card} aria-label="Profile">
          <div className={`${card.head} ${styles.profileHead}`}>
            <span>PROFILE</span>
            <span className={styles.profileNote}>DIN 4023 · depth in m bgl</span>
          </div>
          <ProfileColumn borehole={b} selectedLayer={selectedLayer} onSelectLayer={selectLayer} onOpenSource={onOpenSource} />
          <ProfileLegend borehole={b} />
        </section>

        <div className={styles.right}>
          <MetadataCard borehole={b} onOpenSource={onOpenSource} />
          <LayersTable borehole={b} selectedLayer={selectedLayer} onSelectLayer={selectLayer} onOpenSource={onOpenSource} />
          <GroundwaterTable borehole={b} onOpenSource={onOpenSource} />
        </div>
      </div>
    </div>
  );
}
