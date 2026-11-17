/**
 * Legend of the 3D view: the DIN codes in view as the flat colours drawn (not the hatches), "no DIN
 * code in the record" and "not logged" when they occur, the groundwater symbols, and the lines and
 * surfaces that are shown. Names follow the UI language.
 */
import type { CSSProperties } from 'react';
import { dinColor, type Rgba, type Scene } from './geometry';
import { COLOR, type Show } from './layers3d';
import styles from './View3D.module.css';

interface Props {
  scene: Scene;
  /** What is switched on; `link` is the link actually drawn. */
  show: Show;
  lang: 'en' | 'de';
  t(en: string): string;
}

const css = (c: Rgba) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] / 255).toFixed(2)})`;

/** A flat colour swatch, drawn over the stage's dark tone (as the 3D view shows it). */
function Swatch({ color, kind = 'box' }: { color: Rgba; kind?: 'box' | 'disc' | 'ring' | 'line' }) {
  const style: CSSProperties =
    kind === 'disc'
      ? { background: css(color), boxShadow: 'inset 0 0 0 1px #fff' }
      : kind === 'ring'
        ? { border: `2px solid ${css(color)}` }
        : kind === 'line'
          ? { background: `linear-gradient(${css(color)}, ${css(color)}) center / 100% 3px no-repeat` }
          : { background: css(color) };
  const round = kind === 'disc' || kind === 'ring';
  return (
    <span className={styles.swatchBase} aria-hidden="true">
      <span className={`${styles.swatch} ${round ? styles.round : ''}`} style={style} />
    </span>
  );
}

export function Legend3D({ scene, show, lang, t }: Props) {
  const filled = show.water && scene.water.some((w) => w.filled);
  const open = show.water && scene.water.some((w) => !w.filled);
  const line = show.link === 'line' && scene.waterLine.length > 0;
  const surface = show.link === 'surface' && !!scene.waterSurface;
  return (
    <ul className={styles.legend} aria-label={t('Legend')} data-testid="view3d-legend">
      {show.boreholes &&
        scene.legend.map((l) => (
          <li key={l.code} className={styles.legendItem} data-din={l.code}>
            <Swatch color={dinColor(l.code)} />
            <span className={styles.mono}>{l.code}</span>
            <span>{l.entry ? (lang === 'de' ? l.entry.nameDe : l.entry.nameEn) : t('unknown code')}</span>
          </li>
        ))}
      {show.boreholes && scene.uncoded && (
        <li className={styles.legendItem}>
          <Swatch color={dinColor(null)} />
          <span className={styles.mono}>–</span>
          <span>{t('no DIN code in the record')}</span>
        </li>
      )}
      {show.boreholes && scene.notLogged && (
        <li className={styles.legendItem}>
          <Swatch color={[200, 200, 200, 110]} />
          <span>{t('not logged')}</span>
        </li>
      )}
      {filled && (
        <li className={styles.legendItem}>
          <Swatch color={COLOR.water} kind="disc" />
          <span>{t('rest level or standpipe')}</span>
        </li>
      )}
      {open && (
        <li className={styles.legendItem}>
          <Swatch color={COLOR.water} kind="ring" />
          <span>{t('water strike')}</span>
        </li>
      )}
      {line && (
        <li className={styles.legendItem}>
          <Swatch color={COLOR.waterLine} kind="line" />
          <span>{t('groundwater level, connected')}</span>
        </li>
      )}
      {surface && (
        <li className={styles.legendItem}>
          <Swatch color={COLOR.waterSurface} />
          <span>{t('groundwater surface (interpolated)')}</span>
        </li>
      )}
      {show.ground && scene.groundSurface && (
        <li className={styles.legendItem}>
          <Swatch color={COLOR.groundSurface} />
          <span>{t('ground surface (interpolated)')}</span>
        </li>
      )}
      {show.rock && scene.rockSurface && (
        <li className={styles.legendItem}>
          <Swatch color={COLOR.rockSurface} />
          <span>{t('rock head (interpolated)')}</span>
        </li>
      )}
    </ul>
  );
}
