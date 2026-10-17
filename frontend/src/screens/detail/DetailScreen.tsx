import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { EmptyState } from '../../components/EmptyState';
import { StatusChip } from '../../components/StatusChip';
import { displayStatus } from '../../domain/status';
import { useLang, useT } from '../../i18n';
import { mapHref } from '../../routing/navLinks';
import { sheetPath } from '../../routing/urlState';
import { useAppStore, useIsReviewable, useSelectedBorehole } from '../../store/appStore';
import { depthOriginText, reviewedText, type TestRow } from './detailModel';
import { ExportMenu } from './ExportMenu';
import { GroundwaterTable } from './GroundwaterTable';
import { LayersTable } from './LayersTable';
import { MetadataCard } from './MetadataCard';
import { ProfileColumn, ProfileLegend } from './ProfileColumn';
import { TestResultsTable } from './TestResultsTable';
import card from './cards.module.css';
import styles from './DetailScreen.module.css';

/**
 * Borehole detail: sticky header (breadcrumb, ID, status, values reviewed, › OPEN IN REVIEW,
 * SHEET ›, EXPORT ▾), the DIN 4023 profile on the left, and METADATA + LOCATION, LAYERS,
 * TEST RESULTS and GROUNDWATER on the right. Every value opens the document view (its source and a
 * field to correct it); the profile and the tables share the selected layer (?layer=) and the picked
 * sample.
 */
export function DetailScreen() {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const b = useSelectedBorehole();
  const selectedLayer = useAppStore((s) => s.selectedLayer);
  const selectLayer = useAppStore((s) => s.selectLayer);
  const openSource = useAppStore((s) => s.openSource);
  const openReview = useAppStore((s) => s.openReview);
  const go = useAppStore((s) => s.go);
  const mapTo = useAppStore(mapHref);
  const isSample = useAppStore((s) => s.source?.kind === 'sample');
  const reviewable = useIsReviewable(b?.uid);
  const uid = b?.uid;
  // The picked sample (index into samples), for this borehole only.
  const [pick, setPick] = useState<{ uid: string; sample: number } | null>(null);
  const selectedSample = pick && pick.uid === uid ? pick.sample : null;
  const onOpenSource = useCallback(
    (key: string) => {
      if (uid) openSource(uid, key);
    },
    [uid, openSource],
  );

  if (!b) {
    return (
      <EmptyState
        title={t('NO BOREHOLE SELECTED')}
        message={t('Pick a borehole on the map or in the results table.')}
        action={{ label: t('OPEN MAP'), onClick: () => go('map') }}
      />
    );
  }

  /** A sample marker or a TEST RESULTS row: picks the sample and selects the layer at its depth. */
  const selectAt = (sample: number | null, depth: number | null) => {
    setPick(sample == null ? null : { uid: b.uid, sample });
    const layer = depth == null ? undefined : b.layers.find((l) => depth >= l.from && depth <= l.to);
    if (layer) selectLayer(layer.n);
  };
  const selectSample = (i: number) => {
    const s = b.samples[i];
    selectAt(i, s ? (s.to ?? s.from) : null);
  };
  const selectRow = (r: TestRow) => selectAt(r.sampleIndex, r.at);

  return (
    <div className={styles.screen} data-screen-label="Borehole detail">
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <nav className={styles.crumbs} aria-label="Breadcrumb">
            {/* Back to the last map view (the URL's at), as the header's MAP link. */}
            <Link className={styles.crumbLink} to={mapTo}>
              {t('Map')}
            </Link>
            <span aria-hidden="true">›</span>
            <span>
              {b.project || t('Unnamed project')}
              {isSample ? ` (${t('fictional')})` : ''}
            </span>
          </nav>
          <div className={styles.titleRow}>
            <h1 className={styles.id}>{b.id}</h1>
            <StatusChip status={displayStatus(b)} size="md" />
            <span className={styles.reviewed}>{reviewedText(b)}</span>
          </div>
        </div>
        <div className={styles.spacer} />
        <div className={styles.actions}>
          {reviewable && (
            <button type="button" className={styles.reviewButton} onClick={() => openReview(b.uid)}>
              {t('› OPEN IN REVIEW')}
            </button>
          )}
          <Link className={styles.sheetButton} to={sheetPath(b.uid)} title={t('Generated borehole sheet, printable as PDF')}>
            {t('SHEET ›')}
          </Link>
          <ExportMenu borehole={b} />
        </div>
      </header>

      <div className={styles.body}>
        <section className={card.card} aria-label="Profile">
          <div className={`${card.head} ${styles.profileHead}`}>
            <span>{t('PROFILE')}</span>
            <span className={styles.profileNote}>DIN 4023 · {depthOriginText(b.meta)}</span>
          </div>
          <div className={styles.profileBody}>
            <ProfileColumn
              borehole={b}
              selectedLayer={selectedLayer}
              onSelectLayer={selectLayer}
              onOpenSource={onOpenSource}
              selectedSample={selectedSample}
              onSelectSample={selectSample}
            />
          </div>
          <ProfileLegend borehole={b} de={lang === 'de'} />
        </section>

        <div className={styles.right}>
          <MetadataCard borehole={b} onOpenSource={onOpenSource} />
          <LayersTable borehole={b} selectedLayer={selectedLayer} onSelectLayer={selectLayer} onOpenSource={onOpenSource} />
          <TestResultsTable borehole={b} selectedSample={selectedSample} onSelectRow={selectRow} onOpenSource={onOpenSource} />
          <GroundwaterTable borehole={b} onOpenSource={onOpenSource} />
        </div>
      </div>
    </div>
  );
}
