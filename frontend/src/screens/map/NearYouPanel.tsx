import { StatusChip } from '../../components/StatusChip';
import type { BoreholeStatus } from '../../domain/types';
import type { Compass } from '../../geo/nearest';
import type { NearYouModel } from './mapModel';
import styles from './NearYouPanel.module.css';

const DIRECTION_WORDS: Record<Compass, string> = {
  N: 'north', NE: 'north-east', E: 'east', SE: 'south-east', S: 'south', SW: 'south-west', W: 'west', NW: 'north-west',
};

interface Props {
  model: NearYouModel;
  simulated: boolean;
  statuses: Map<string, BoreholeStatus>;
  onOpen(uid: string): void;
  onClose(): void;
}

/**
 * NEAR YOU, over the top-right of the map after MY LOCATION: accuracy, the five nearest boreholes with
 * distance, direction and review status (each opens Borehole detail), and the privacy note. Closes
 * with × or Escape.
 */
export function NearYouPanel({ model, simulated, statuses, onOpen, onClose }: Props) {
  return (
    <section className={styles.panel} aria-labelledby="near-you-title">
      <div className={styles.head}>
        <h2 id="near-you-title" className={styles.title}>
          NEAR YOU
        </h2>
        {simulated && <span className={styles.simulated}>SIMULATED LOCATION</span>}
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close near you">
          ×
        </button>
      </div>
      <div className={styles.accuracy}>{model.accuracy}</div>
      {model.farMessage && (
        <p className={styles.far} role="status">
          {model.farMessage}
        </p>
      )}
      {model.rows.length === 0 ? (
        <p className={styles.far}>No borehole with coordinates yet.</p>
      ) : (
        <ol className={styles.list}>
          {model.rows.map(({ item: b, distance, direction }) => (
            <li key={b.uid}>
              <button
                type="button"
                className={styles.row}
                data-uid={b.uid}
                aria-label={`Open detail of ${b.id}, ${direction ? `${distance} ${DIRECTION_WORDS[direction]}` : distance}`}
                onClick={() => onOpen(b.uid)}
              >
                <span className={styles.id}>{b.id}</span>
                <span className={styles.distance}>
                  {distance}
                  {direction && <span className={styles.direction}> {direction}</span>}
                </span>
                <span className={styles.project}>{b.project}</span>
                <span className={styles.chip}>
                  <StatusChip status={statuses.get(b.uid) ?? 'unreviewed'} size="sm" />
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <p className={styles.privacy}>Your location stays in this browser.</p>
    </section>
  );
}
