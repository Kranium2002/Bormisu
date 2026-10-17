import { displayStatus } from '../../domain/status';
import type { Borehole } from '../../domain/types';
import { useT } from '../../i18n';
import { pinColor } from '../../theme';
import { Chips } from './Chips';
import { locationInfo, metadataRows } from './detailModel';
import { LocationMap } from './LocationMap';
import { ValueCell } from './ValueCell';
import card from './cards.module.css';
import styles from './MetadataCard.module.css';

interface Props {
  borehole: Borehole;
  onOpenSource(key: string): void;
}

const TONE_CLASS = { muted: styles.locMuted, amber: styles.locAmber, red: styles.locRed } as const;

/**
 * METADATA rows (label · status dot · value, numbers in the mono face, status chips such as the CRS
 * state) next to the LOCATION mini map with the CRS the position comes from. A click on a value
 * opens the document view. Rows for fields the source doesn't have are left out; unknown values read
 * "not in source", never 0.
 */
export function MetadataCard({ borehole: b, onOpenSource }: Props) {
  const t = useT();
  const rows = metadataRows(b);
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
              <div className={styles.label}>{t(r.label)}</div>
              <div className={styles.value}>
                <ValueCell
                  certainty={r.certainty}
                  className={styles.valueCell}
                  onOpen={key && r.source !== 'none' ? () => onOpenSource(key) : undefined}
                >
                  <span className={face}>{r.shown.missing ? t(r.shown.text) : r.shown.text}</span>
                </ValueCell>
                <Chips chips={r.chips.filter((c) => c.label !== 'LINT' && c.label !== 'FLAGGED')} />
                {r.sub && <span className={styles.sub}>{r.sub}</span>}
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
            color={pinColor(displayStatus(b))}
            label={`Map of ${b.id} at ${loc.text}`}
          />
        ) : (
          <div className={`${styles.map} ${styles.noMap}`}>{t('No usable coordinates')}</div>
        )}
        <div className={`${styles.locText} ${TONE_CLASS[loc.tone]}`}>{loc.text}</div>
      </div>
    </section>
  );
}
