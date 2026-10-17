import { ValueCell } from '../../components/ValueCell';
import { boreholeStatus } from '../../domain/review';
import type { Borehole } from '../../domain/types';
import { pinColor } from '../../theme';
import { locationInfo, metadataRows } from './detailModel';
import { LocationMap } from './LocationMap';
import card from './cards.module.css';
import styles from './MetadataCard.module.css';
import { useT } from '../../i18n';

interface Props {
  borehole: Borehole;
  onOpenSource(key: string): void;
}

const TONE_CLASS = { muted: styles.locMuted, amber: styles.locAmber, red: styles.locRed } as const;

/** METADATA rows (value, chips, method badge, source icon) next to the LOCATION mini map. */
export function MetadataCard({ borehole: b, onOpenSource }: Props) {
  const rows = metadataRows(b);
  const t = useT();
  const loc = locationInfo(b);
  const pin = b.onMap && b.lat != null && b.lng != null ? { lat: b.lat, lng: b.lng } : null;

  return (
    <section className={`${card.card} ${styles.grid}`} aria-label="Metadata">
      <div className={styles.meta}>
        <div className={card.head}>{t('METADATA')}</div>
        {rows.map((r) => {
          const key = r.key;
          // Numbers in the mono face; words and "not in source" stay in the sans.
          const face = r.shown.missing ? card.missing : r.numeric ? card.mono : '';
          return (
            <div key={r.label} className={styles.row}>
              <div className={styles.label}>{r.label}</div>
              <div className={styles.value}>
                <ValueCell certainty={r.certainty} onOpen={r.source.clickable && key ? () => onOpenSource(key) : undefined}>
                  <span className={face}>{r.shown.text}</span>
                </ValueCell>
              </div>
            </div>
          );
        })}
      </div>
      <div className={styles.location}>
        <div className={card.head}>{t('LOCATION')}</div>
        {pin ? (
          <LocationMap
            lat={pin.lat}
            lng={pin.lng}
            color={pinColor(boreholeStatus(b))}
            label={`Map of ${b.id} at ${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)}`}
          />
        ) : (
          <div className={`${styles.map} ${styles.noMap}`}>No usable coordinates</div>
        )}
        {loc && <div className={`${styles.locText} ${TONE_CLASS[loc.tone]}`}>{loc.text}</div>}
      </div>
    </section>
  );
}
