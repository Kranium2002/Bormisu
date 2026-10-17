import type { KeyboardEvent } from 'react';
import { K } from '../../domain/keys';
import type { Borehole, Layer } from '../../domain/types';
import { COL, STRAT_COLORS, STRAT_FALLBACK } from '../../theme';
import { GW_LABEL } from './detailModel';
import { dinPatternId, MISSING_PATTERN, patternDefs } from './dinPatterns';
import {
  depthScale,
  depthTicks,
  drawnMarks,
  gwTriangle,
  notLogged,
  PROFILE_H,
  PROFILE_TOP,
  PROFILE_W,
  stratBlocks,
  X,
} from './profileGeometry';
import styles from './ProfileColumn.module.css';

interface Props {
  borehole: Borehole;
  selectedLayer: number;
  onSelectLayer(n: number): void;
  /** Opens the Source panel for a value key of this borehole. */
  onOpenSource(key: string): void;
}

const INK = COL.text;
/** Hatching of the "not logged" band; the layers use the DIN 4023 patterns (dinPatterns.ts). */
const NL_PATTERN = 'bp-nl';

/** Enter / Space on a focusable SVG group acts like a click. */
const onKeyActivate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fn();
  }
};

/**
 * DIN 4023 borehole profile: depth axis with ticks, Strat. column, hatched lithology column
 * (layers clickable), "not logged" band, ET label, rock head, selection, groundwater triangles
 * and the amber R marker of the first SPT refusal (both open the Source panel).
 */
export function ProfileColumn({ borehole: b, selectedLayer, onSelectLayer, onOpenSource }: Props) {
  const { depth, s, y } = depthScale(b);
  const ticks = depthTicks(depth);
  const strat = stratBlocks(b.layers);
  const nl = notLogged(b);
  const sel = b.layers.find((l) => l.n === selectedLayer);
  // Measurements the reviewer marked "not in source" / "illegible" aren't drawn.
  const { refusal, groundwater, rockHead } = drawnMarks(b);
  const etY = y(depth) + 18;
  const dinIds = b.layers.map(dinPatternId);
  // The rock head line and its label already give that depth; a bottom label there would be crossed out.
  const onRockHead = (d: number) => rockHead != null && Math.abs(d - rockHead) < 0.005;
  /** Baseline of a layer's DIN code: mid-layer, or just above the R marker's line when that would cross it. */
  const codeY = (l: Layer) => {
    const mid = y((l.from + l.to) / 2) + 4;
    if (!refusal) return mid;
    const lineY = y(refusal.depth);
    return mid > lineY - 4 && mid < lineY + 12 ? lineY - 5 : mid;
  };

  return (
    <svg
      className={styles.svg}
      width={PROFILE_W}
      height={PROFILE_H}
      viewBox={`0 0 ${PROFILE_W} ${PROFILE_H}`}
      // A group, not an img: an img's children are presentational, and the layers, GW triangles
      // and the R marker inside are buttons.
      role="group"
      aria-label={`DIN 4023 profile of ${b.id}, ${b.layers.length} layers, final depth ${b.finalDepth != null ? `${b.finalDepth.toFixed(2)} m` : 'not stated'}`}
    >
      <defs dangerouslySetInnerHTML={{ __html: patternDefs(dinIds) }} />
      <defs>
        <pattern id={NL_PATTERN} width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M0 8 L8 0" stroke={COL.border} strokeWidth="1" />
        </pattern>
      </defs>

      <text x={X.stratMid} y="18" fontSize="10" fill={COL.faint} textAnchor="middle">Strat.</text>
      <text x={X.layerMid} y="18" fontSize="10" fill={COL.faint} textAnchor="middle">Lithology</text>

      {/* depth axis */}
      <line x1={X.axis} y1={PROFILE_TOP} x2={X.axis} y2={y(depth)} stroke={INK} />
      {ticks.map((d) => (
        <g key={d}>
          <line x1={X.tickFrom} y1={y(d)} x2={X.axis} y2={y(d)} stroke={INK} />
          <text x="34" y={y(d) + 4} fontSize="10" textAnchor="end" fill={INK}>{d}</text>
        </g>
      ))}

      {/* stratigraphy */}
      {strat.map((blk) => {
        const h = (blk.to - blk.from) * s;
        return (
          <g key={`${blk.code}-${blk.from}`}>
            <title>{`Stratigraphy ${blk.code || 'not stated'}: ${blk.from.toFixed(2)}–${blk.to.toFixed(2)} m`}</title>
            <rect x={X.stratX} y={y(blk.from)} width={X.stratW} height={h} fill={STRAT_COLORS[blk.code] ?? STRAT_FALLBACK} stroke={INK} />
            {h > 14 && (
              <text x={X.stratMid} y={y((blk.from + blk.to) / 2) + 4} fontSize="10" textAnchor="middle" fill={INK}>
                {blk.code}
              </text>
            )}
          </g>
        );
      })}

      {/* lithology */}
      {b.layers.map((l, i) => {
        const h = (l.to - l.from) * s;
        const dinId = dinIds[i];
        const select = () => onSelectLayer(l.n);
        return (
          <g
            key={l.n}
            className={styles.hit}
            role="button"
            tabIndex={0}
            aria-label={`Layer ${l.n}: ${l.lithology}, ${l.from.toFixed(2)}–${l.to.toFixed(2)} m`}
            aria-pressed={l.n === selectedLayer}
            onClick={select}
            onKeyDown={onKeyActivate(select)}
          >
            <title>{`Layer ${l.n} · ${l.din} · ${l.lithology}${dinId === MISSING_PATTERN ? ` · no DIN 4023 pattern for "${l.din}"` : ''}`}</title>
            {/* white under the tile: "A" (fill) has no DIN colour; unknown code: plain #E0E0E0 (README) */}
            <rect x={X.layerX} y={y(l.from)} width={X.layerW} height={h} fill={dinId ? '#fff' : '#E0E0E0'} />
            {dinId && <rect x={X.layerX} y={y(l.from)} width={X.layerW} height={h} fill={`url(#${dinId})`} />}
            <rect x={X.layerX} y={y(l.from)} width={X.layerW} height={h} fill="none" stroke={INK} />
            {dinId === MISSING_PATTERN && h > 12 && (
              <text x={X.layerMid} y={y((l.from + l.to) / 2) + 3} fontSize="9" fontWeight="700" textAnchor="middle" fill="#fff">
                no pattern assigned
              </text>
            )}
            <line x1={X.layerX + X.layerW} y1={y(l.to)} x2={X.bottomTickTo} y2={y(l.to)} stroke={INK} />
            {!onRockHead(l.to) && (
              <text x={X.bottomLabel} y={y(l.to) + 4} fontSize="10" fill={INK}>{l.to.toFixed(2)}</text>
            )}
            {h > 12 && (
              <text x={X.code} y={codeY(l)} fontSize="11" fontWeight="700" fill={INK}>{l.din}</text>
            )}
          </g>
        );
      })}

      {b.layers.length === 0 && (
        <text x={X.layerMid} y={PROFILE_TOP + 40} fontSize="11" textAnchor="middle" fill={COL.faint} fontStyle="italic">
          no layers in source
        </text>
      )}

      {/* log ends above the final depth */}
      {nl && (
        <g>
          <title>The log stops above the final depth. A sheet may be missing.</title>
          <rect
            x={X.layerX}
            y={y(nl.from)}
            width={X.layerW}
            height={(nl.to - nl.from) * s}
            fill={`url(#${NL_PATTERN})`}
            stroke={COL.red}
            strokeDasharray="4 3"
          />
          <text x={X.layerMid} y={y((nl.from + nl.to) / 2) + 4} fontSize="10" textAnchor="middle" fill={COL.muted}>not logged</text>
          <text x={X.bottomLabel} y={y((nl.from + nl.to) / 2) + 4} fontSize="10" fill={COL.red}>{nl.label}</text>
        </g>
      )}

      <text x={X.layerMid} y={etY} fontSize="10" textAnchor="middle" fill={INK}>
        {b.finalDepth != null && b.finalDepth > 0 ? `ET ${b.finalDepth.toFixed(2)} m` : 'ET not stated'}
      </text>

      {/* rock head */}
      {rockHead != null && (
        <g>
          <title>{`Rock head ${rockHead.toFixed(2)} m`}</title>
          <line x1={X.rockFrom} y1={y(rockHead)} x2={X.rockTo} y2={y(rockHead)} stroke={COL.dark} strokeWidth="1.5" strokeDasharray="6 3" />
          <text x={X.code} y={y(rockHead) + 14} fontSize="10" fill={COL.dark} fontWeight="700">
            {`rock head ${rockHead.toFixed(2)}`}
          </text>
        </g>
      )}

      {/* selected layer */}
      {sel && (
        <rect
          className={styles.noHit}
          x={X.layerX - 2}
          y={y(sel.from) - 2}
          width={X.layerW + 4}
          height={(sel.to - sel.from) * s + 4}
          fill="none"
          stroke={COL.green}
          strokeWidth="3"
        />
      )}

      {/* groundwater: strike filled, rest level (and other readings) hollow */}
      {groundwater.map((g) => {
        const gy = y(g.depth);
        const label = `GW ${GW_LABEL[g.type].toLowerCase()} ${g.depth.toFixed(2)} m`;
        const open = () => onOpenSource(g.key);
        return (
          <g
            key={g.key}
            className={styles.hit}
            role="button"
            tabIndex={0}
            aria-label={`${label}: show source`}
            onClick={open}
            onKeyDown={onKeyActivate(open)}
          >
            <title>{label}</title>
            <line x1={X.gwFrom} y1={gy} x2={X.layerX} y2={gy} stroke={COL.gw} strokeWidth="1.5" />
            <path d={gwTriangle(gy)} fill={g.type === 'strike' ? COL.gw : '#fff'} stroke={COL.gw} strokeWidth="1.5" />
          </g>
        );
      })}

      {/* first SPT refusal */}
      {refusal && (
        <g
          className={styles.hit}
          role="button"
          tabIndex={0}
          aria-label={`SPT refusal ${refusal.raw} at ${refusal.depth.toFixed(2)} m: show source`}
          onClick={() => onOpenSource(K.spt(refusal.layer.n))}
          onKeyDown={onKeyActivate(() => onOpenSource(K.spt(refusal.layer.n)))}
        >
          <title>{`SPT refusal “${refusal.raw}” at ${refusal.depth.toFixed(2)} m — click to see the source`}</title>
          <line
            x1={X.layerX + X.layerW}
            y1={y(refusal.depth)}
            x2={X.refusalX}
            y2={y(refusal.depth)}
            stroke={COL.amber}
            strokeWidth="1"
            strokeDasharray="2 2"
          />
          <rect x={X.refusalX} y={y(refusal.depth) - 9} width="22" height="18" rx="2" fill={COL.amber} />
          <text x={X.refusalX + 11} y={y(refusal.depth) + 5} fontSize="12" fontWeight="800" textAnchor="middle" fill={INK}>R</text>
        </g>
      )}
    </svg>
  );
}

/** Legend under the profile: only the symbols this profile draws. Nothing drawn, no legend. */
export function ProfileLegend({ borehole }: { borehole: Borehole }) {
  const { groundwater, refusal } = drawnMarks(borehole);
  const strike = groundwater.some((g) => g.type === 'strike');
  // Rest levels and other readings share the hollow triangle.
  const hollow = [...new Set(groundwater.filter((g) => g.type !== 'strike').map((g) => g.type))];
  if (!strike && hollow.length === 0 && !refusal) return null;
  return (
    <div className={styles.legend}>
      {strike && (
        <span className={styles.legendItem}>
          <svg width="12" height="10" aria-hidden="true">
            <path d="M1 1 L11 1 L6 9 Z" fill={COL.gw} />
          </svg>
          GW strike
        </span>
      )}
      {hollow.length > 0 && (
        <span className={styles.legendItem}>
          <svg width="12" height="10" aria-hidden="true">
            <path d="M1 1 L11 1 L6 9 Z" fill="#fff" stroke={COL.gw} strokeWidth="1.5" />
          </svg>
          {`GW ${hollow.map((t) => GW_LABEL[t].toLowerCase()).join(', ')}`}
        </span>
      )}
      {refusal && (
        <span className={styles.legendItem}>
          <span className={styles.rBadge} aria-hidden="true">R</span>SPT refusal: click for source
        </span>
      )}
    </div>
  );
}
