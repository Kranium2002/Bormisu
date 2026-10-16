import { MethodBadge } from '../../components/MethodBadge';
import { SourceIcon } from '../../components/SourceIcon';
import { boreholeStatus } from '../../domain/review';
import type { Borehole } from '../../domain/types';
import { pinColor } from '../../theme';
import { Chips } from './Chips';
import { locationInfo, metadataRows } from './detailModel';
import { LocationMap } from './LocationMap';
import card from './cards.module.css';
import styles from './MetadataCard.module.css';

interface Props {
  borehole: Borehole;
  onOpenSource(key: string): void;
}

const TONE_CLASS = { muted: styles.locMuted, amber: styles.locAmber, red: styles.locRed } as const;

/** METADATA rows (value, chips, method badge, source icon) next to the LOCATION mini map. */
export function MetadataCard({ borehole: b, onOpenSource }: Props) {
  const rows = metadataRows(b);
  const loc = locationInfo(b);
  const pin = b.onMap && b.lat != null && b.lng != null ? { lat: b.lat, lng: b.lng } : null;

  return (
    <section className={`${card.card} ${styles.grid}`} aria-label="Metadata">
      <div className={styles.meta}>
        <div className={card.head}>METADATA</div>
        {rows.map((r) => {
          const key = r.key;
          return (
            <div key={r.label} className={styles.row}>
              <div className={styles.label}>{r.label}</div>
              <div className={styles.value}>
                <span className={`${card.mono} ${r.shown.missing ? card.missing : ''}`}>{r.shown.text}</span>
                <Chips chips={r.chips} />
              </div>
              <div>{r.method && <MethodBadge method={r.method} confidence={r.confidence} formula={r.formula} />}</div>
              <div>
                <SourceIcon
                  dim={r.dimSource}
                  title={key ? 'Show source' : 'Nothing printed to show'}
                  onClick={key ? () => onOpenSource(key) : undefined}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className={styles.location}>
        <div className={card.head}>LOCATION</div>
        {pin ? (
          <LocationMap
            lat={pin.lat}
            lng={pin.lng}
            color={pinColor(boreholeStatus(b))}
            label={`Map of ${b.id} at ${loc.text}`}
          />
        ) : (
          <div className={`${styles.map} ${styles.noMap}`}>No usable coordinates</div>
        )}
        <div className={`${styles.locText} ${TONE_CLASS[loc.tone]}`}>{loc.text}</div>
      </div>
    </section>
  );
}
