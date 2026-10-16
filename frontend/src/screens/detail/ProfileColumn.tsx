import type { KeyboardEvent } from 'react';
import { decimalComma } from '../../domain/format';
import { K } from '../../domain/keys';
import type { Borehole, Layer, PatternId } from '../../domain/types';
import { COL, PATTERN_FILLS, STRAT_COLORS, STRAT_FALLBACK } from '../../theme';
import { GW_LABEL } from './detailModel';
import {
  depthScale,
  depthTicks,
  firstRefusal,
  gwTriangle,
  isStated,
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
/** Pattern ids are prefixed so they can't clash with other SVGs on the page. */
const pat = (id: PatternId | 'nl') => `bp-${id}`;

/** DIN 4023 hatchings (prototype <defs>), drawn over the pastel layer fill. */
function PatternDefs() {
  return (
    <defs>
      <pattern id={pat('topsoil')} width="22" height="16" patternUnits="userSpaceOnUse">
        <text x="3" y="11" fontSize="8" fill={INK}>M</text>
        <text x="14" y="15" fontSize="6" fill={INK}>u</text>
      </pattern>
      <pattern id={pat('fill')} width="26" height="22" patternUnits="userSpaceOnUse">
        <text x="3" y="10" fontSize="9" fill={INK}>A</text>
        <text x="15" y="20" fontSize="9" fill={INK}>A</text>
      </pattern>
      <pattern id={pat('clay')} width="28" height="12" patternUnits="userSpaceOnUse">
        <line x1="2" y1="3" x2="14" y2="3" stroke={INK} strokeWidth="1" />
        <line x1="15" y1="9" x2="27" y2="9" stroke={INK} strokeWidth="1" />
      </pattern>
      <pattern id={pat('silt')} width="24" height="14" patternUnits="userSpaceOnUse">
        <path d="M3 4 q2 3 4 0 M15 11 q2 3 4 0" stroke={INK} fill="none" strokeWidth="1" />
        <circle cx="11" cy="4" r=".8" fill={INK} />
        <circle cx="22" cy="11" r=".8" fill={INK} />
      </pattern>
      <pattern id={pat('gravel')} width="26" height="22" patternUnits="userSpaceOnUse">
        <circle cx="6" cy="6" r="3.2" stroke={INK} fill="none" />
        <circle cx="19" cy="15" r="3.2" stroke={INK} fill="none" />
        <circle cx="17" cy="4" r="1.1" fill={INK} />
        <circle cx="6" cy="17" r="1.1" fill={INK} />
      </pattern>
      <pattern id={pat('sst')} width="20" height="14" patternUnits="userSpaceOnUse">
        <line x1="0" y1="13.5" x2="20" y2="13.5" stroke={INK} strokeWidth=".7" />
        <circle cx="5" cy="5" r="1" fill={INK} />
        <circle cx="15" cy="9" r="1" fill={INK} />
      </pattern>
      <pattern id={pat('sand')} width="12" height="10" patternUnits="userSpaceOnUse">
        <circle cx="3" cy="3" r=".9" fill={INK} />
        <circle cx="9" cy="8" r=".9" fill={INK} />
      </pattern>
      <pattern id={pat('lst')} width="24" height="12" patternUnits="userSpaceOnUse">
        <path d="M0 0.5 H24 M0 6.5 H24 M6 0.5 V6.5 M18 6.5 V12" stroke={INK} strokeWidth=".8" fill="none" />
      </pattern>
      <pattern id={pat('marl')} width="20" height="12" patternUnits="userSpaceOnUse">
        <path d="M2 3 H10 M12 9 H19" stroke={INK} strokeWidth=".9" />
        <path d="M14 2 V5 M5 8 V11" stroke={INK} strokeWidth=".9" />
      </pattern>
      <pattern id={pat('nl')} width="8" height="8" patternUnits="userSpaceOnUse">
        <path d="M0 8 L8 0" stroke={COL.border} strokeWidth="1" />
      </pattern>
    </defs>
  );
}

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
  const refusal = firstRefusal(b.layers.filter((l) => isStated(b, K.spt(l.n))));
  const groundwater = b.groundwater.filter((g) => isStated(b, g.key));
  const rockHead = isStated(b, K.rockHead) ? b.rockHead : null;
  const etY = y(depth) + 18;
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
      aria-label={`DIN 4023 profile of ${b.id}, ${b.layers.length} layers, final depth ${b.finalDepth != null ? `${decimalComma(b.finalDepth)} m` : 'not stated'}`}
    >
      <PatternDefs />

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
            <title>{`Stratigraphy ${blk.code || 'not stated'}: ${decimalComma(blk.from)}–${decimalComma(blk.to)} m`}</title>
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
      {b.layers.map((l) => {
        const h = (l.to - l.from) * s;
        const select = () => onSelectLayer(l.n);
        return (
          <g
            key={l.n}
            className={styles.hit}
            role="button"
            tabIndex={0}
            aria-label={`Layer ${l.n}: ${l.lithology}, ${decimalComma(l.from)}–${decimalComma(l.to)} m`}
            aria-pressed={l.n === selectedLayer}
            onClick={select}
            onKeyDown={onKeyActivate(select)}
          >
            <title>{`Layer ${l.n} · ${l.din} · ${l.lithology}`}</title>
            <rect x={X.layerX} y={y(l.from)} width={X.layerW} height={h} fill={l.fill || PATTERN_FILLS[l.pattern]} />
            <rect x={X.layerX} y={y(l.from)} width={X.layerW} height={h} fill={`url(#${pat(l.pattern)})`} stroke={INK} />
            <line x1={X.layerX + X.layerW} y1={y(l.to)} x2={X.bottomTickTo} y2={y(l.to)} stroke={INK} />
            {!onRockHead(l.to) && (
              <text x={X.bottomLabel} y={y(l.to) + 4} fontSize="10" fill={INK}>{decimalComma(l.to)}</text>
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
            fill={`url(#${pat('nl')})`}
            stroke={COL.red}
            strokeDasharray="4 3"
          />
          <text x={X.layerMid} y={y((nl.from + nl.to) / 2) + 4} fontSize="10" textAnchor="middle" fill={COL.muted}>not logged</text>
          <text x={X.bottomLabel} y={y((nl.from + nl.to) / 2) + 4} fontSize="10" fill={COL.red}>{nl.label}</text>
        </g>
      )}

      <text x={X.layerMid} y={etY} fontSize="10" textAnchor="middle" fill={INK}>
        {b.finalDepth != null && b.finalDepth > 0 ? `ET ${decimalComma(b.finalDepth)} m` : 'ET not stated'}
      </text>

      {/* rock head */}
      {rockHead != null && (
        <g>
          <title>{`Rock head ${decimalComma(rockHead)} m`}</title>
          <line x1={X.rockFrom} y1={y(rockHead)} x2={X.rockTo} y2={y(rockHead)} stroke={COL.dark} strokeWidth="1.5" strokeDasharray="6 3" />
          <text x={X.code} y={y(rockHead) + 14} fontSize="10" fill={COL.dark} fontWeight="700">
            {`rock head ${decimalComma(rockHead)}`}
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

/** Legend under the profile. */
export function ProfileLegend() {
  return (
    <div className={styles.legend}>
      <span className={styles.legendItem}>
        <svg width="12" height="10" aria-hidden="true">
          <path d="M1 1 L11 1 L6 9 Z" fill={COL.gw} />
        </svg>
        GW strike
      </span>
      <span className={styles.legendItem}>
        <svg width="12" height="10" aria-hidden="true">
          <path d="M1 1 L11 1 L6 9 Z" fill="#fff" stroke={COL.gw} strokeWidth="1.5" />
        </svg>
        GW rest level
      </span>
      <span className={styles.legendItem}>
        <span className={styles.rBadge}>R</span>SPT refusal (click)
      </span>
    </div>
  );
}
