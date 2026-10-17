import type { BoreholeStatus } from '../domain/types';
import { useT } from '../i18n';
import { statusChip } from '../theme';
import styles from './StatusChip.module.css';

interface Props {
  /** displayStatus(b) from domain/status.ts. */
  status: BoreholeStatus;
  /** `sm` for table rows and popups, `md` for the detail header. */
  size?: 'sm' | 'md';
}

/** Status chip: Approved (green) / In review, Unreviewed (grey) / Needs attention (amber). */
export function StatusChip({ status, size = 'sm' }: Props) {
  const c = statusChip(status);
  const t = useT();
  return (
    <span className={`${styles.chip} ${styles[size]}`} style={{ background: c.bg, color: c.fg }}>
      {t(c.label)}
    </span>
  );
}
