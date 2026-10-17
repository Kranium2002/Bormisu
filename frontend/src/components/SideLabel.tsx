import { useT } from '../i18n';
import styles from './SideLabel.module.css';

/** "file.pdf, page 7": the file and the page when known. */
const placeOf = (t: (en: string) => string, file: string | null | undefined, page: number | null | undefined) =>
  [file, page != null ? `${t('page')} ${page}` : null].filter(Boolean).join(', ');

/** "ORIGINAL · file.pdf, page 7 (as uploaded)" in the language of `t`, e.g. for a tooltip. */
export function originalLabel(t: (en: string) => string, file: string | null | undefined, page: number | null | undefined): string {
  const where = placeOf(t, file, page);
  return `${t('ORIGINAL')}${where ? ` · ${where}` : ''} (${t('as uploaded')})`;
}

/**
 * Names the side of a page view that shows the upload itself: ORIGINAL · <file>, page <n> (as
 * uploaded). Next to a reconstruction (ReconstructedLabel) a reviewer always knows which side is
 * the scan and which was rebuilt from the extracted values.
 */
export function OriginalLabel({ file, page }: { file?: string | null; page?: number | null }) {
  const t = useT();
  const where = placeOf(t, file, page);
  return (
    <span className={styles.label}>
      <span className={styles.side}>{t('ORIGINAL')}</span>
      {where ? ` · ${where}` : ''} ({t('as uploaded')})
    </span>
  );
}

/** Names the side rebuilt from the extracted values: RECONSTRUCTED · from extracted values. */
export function ReconstructedLabel() {
  const t = useT();
  return (
    <span className={styles.label}>
      <span className={styles.side}>{t('RECONSTRUCTED')}</span> · {t('from extracted values')}
    </span>
  );
}
