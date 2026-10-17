import type { LiveStatus as Status } from '../domain/types';
import styles from './LiveStatus.module.css';

/** What the status line says for each transport state of live updates. */
export const LIVE_STATUS_TEXT: Record<Status, string> = {
  connecting: 'Connecting to live updates…',
  live: 'Live',
  polling: 'Updating every few seconds',
  offline: 'Offline, retrying',
};

/** Longer explanation (tooltip) of each state. */
const LIVE_STATUS_TITLE: Record<Status, string> = {
  connecting: 'Opening the live update stream',
  live: 'Changes appear as the server makes them',
  polling: 'The live stream is unavailable; documents in progress are checked every few seconds',
  offline: 'The server cannot be reached; trying again',
};

/**
 * How live updates arrive (stream, polling fallback, offline), as a short status line with a dot.
 * A polite live region, so a change of transport is announced once.
 */
export function LiveStatus({ status }: { status: Status }) {
  return (
    <p className={`${styles.line} ${styles[status]}`} role="status" aria-live="polite" title={LIVE_STATUS_TITLE[status]}>
      <span className={styles.dot} aria-hidden="true" />
      {LIVE_STATUS_TEXT[status]}
    </p>
  );
}
