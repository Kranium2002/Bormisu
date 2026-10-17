import type { Box } from '../../domain/types';
import { useT } from '../../i18n';
import styles from './VerifyScreen.module.css';
import { fontSizeFor, type VerifyItem, type VerifyWord } from './verifyModel';

interface Props {
  /** Paper size in px: the same as the original page next to it. */
  width: number;
  height: number;
  /** The borehole's values on this page that have a box. */
  items: VerifyItem[];
  selectedKey: string | null;
  onSelect(key: string): void;
  /**
   * OCR / text-layer words of the page (GET /documents/{id}/pages/{n}/words, coming later), drawn as
   * faint grey text behind the values. Unused until the backend sends them.
   */
  words?: VerifyWord[];
  /** The selected value is backed by the whole page: the paper's outline shows it. */
  pageSelected?: boolean;
}

/** Absolute position of a normalised box, in % of the paper. */
export const boxStyle = (b: Box) => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });

/**
 * The "extracted page": a blank paper the size of the original page, with each value drawn where it
 * was read, as normalised text (+ unit) sized to its box and coloured by certainty.
 */
export function ExtractedPage({ width, height, items, selectedKey, onSelect, words, pageSelected }: Props) {
  const t = useT();
  return (
    <div
      className={`${styles.paper} ${pageSelected ? styles.pageSelected : ''}`}
      style={{ width, height }}
      aria-label={t('Extracted page')}
    >
      {words?.map((w, i) => (
        <span
          key={i}
          className={styles.word}
          style={{ ...boxStyle(w.box), fontSize: fontSizeFor(w.text, w.box, width, height) }}
          aria-hidden
        >
          {w.text}
        </span>
      ))}
      {items.map((it) => {
        const box = it.box!;
        const selected = it.key === selectedKey;
        const cls = [styles.value, styles[it.certainty.kind], it.placement === 'approx' ? styles.approx : '', selected ? styles.selected : '']
          .filter(Boolean)
          .join(' ');
        return (
          <button
            key={it.key}
            type="button"
            className={cls}
            style={{ ...boxStyle(box), fontSize: fontSizeFor(it.text, box, width, height) }}
            title={it.title}
            aria-label={`${it.label}: ${it.text}`}
            aria-pressed={selected}
            onClick={() => onSelect(it.key)}
          >
            <span className={styles.valueText}>{it.text}</span>
            {it.placement === 'approx' && <span className={styles.approxTag}>{t('approx.')}</span>}
          </button>
        );
      })}
    </div>
  );
}
