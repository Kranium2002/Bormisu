import type { KeyboardEvent } from 'react';
import { dinEntry, dinFill, dinLegendItems, dinNeedsUnderlay } from '../../domain/din';
import { decimalComma } from '../../domain/format';
import { K } from '../../domain/keys';
import type { Borehole, GroundwaterReading, Layer } from '../../domain/types';
import { COL } from '../../theme';
import { GW_LABEL } from './detailModel';
import {
  depthScale,
  depthTicks,
  firstRefusal,
  fitText,
  gwTriangle,
  isStated,
  LABEL_FONT,
  layerLabel,
  notLogged,
  PROFILE_H,
  PROFILE_TOP,
  PROFILE_W,
  refusalMarkerDepth,
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
/** The Strat. column is neutral: the name is the information, there is no colour table. */
const STRAT_FILL = '#F4F4F4';
/** Hatching of the "not logged" band (a UI mark, not a DIN pattern). */
const NOT_LOGGED_ID = 'bp-nl';
/** Room for a layer label right of the column, and next to the R marker. */
const LABEL_MAX_W = PROFILE_W - X.code - 4;
const LABEL_MAX_W_NEAR_MARKER = X.refusalX - X.code - 8;
/** Half the height of the R marker badge, px. */
const MARKER_HALF = 9;

/** Enter / Space on a focusable SVG group acts like a click. */
const onKeyActivate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fn();
  }
};

/** Hover text of a layer: number, DIN notation or code, English lithology, and the description as printed. */
function layerTitle(l: Layer): string {
  const code = l.dinNotation?.trim() || l.din || 'no DIN code';
  const unknown = l.din && !dinEntry(l.din) ? ` (${l.din} is not a DIN 4023 code)` : '';
  const printed = l.lithologyAsPrinted ? `\nas printed: “${l.lithologyAsPrinted}”` : '';
  return `Layer ${l.n} · ${code}${unknown} · ${l.lithology || 'no description'}${printed}`;
}

type StatedReading = GroundwaterReading & { depth: number };

/**
 * DIN 4023 borehole profile: depth axis with ticks, Strat. column (stratigraphic names), lithology
 * column filled with the DIN 4023 patterns of assets/din4023_patterns (layers clickable),
 * "not logged" band, ET label, rock head, selection, groundwater triangles and the amber R marker
 * of the first SPT refusal (both open the Source panel).
 *
 * The patterns come from DinPatternDefs, mounted once in the app. A known code fills with
 * `url(#<pattern_id>)` at the native tile size; `A` gets a white underlay; an unknown code is plain
 * #E0E0E0 with the code as text; a layer without a code is plain #E0E0E0.
 */
export function ProfileColumn({ borehole: b, selectedLayer, onSelectLayer, onOpenSource }: Props) {
  const { depth, s, y } = depthScale(b);
  const ticks = depthTicks(depth);
  const strat = stratBlocks(b.layers);
  const nl = notLogged(b);
  const sel = b.layers.find((l) => l.n === selectedLayer);
  // Measurements the reviewer marked "not in source" / "illegible" aren't drawn, nor readings without a depth.
  const refusal = firstRefusal(b.layers.filter((l) => isStated(b, K.spt(l.n))));
  const marker = refusal ? refusalMarkerDepth(refusal) : null;
  const markerY = marker ? y(marker.at) : null;
  const groundwater = b.groundwater.filter((g): g is StatedReading => g.depth != null && isStated(b, g.key));
  const rockHead = isStated(b, K.rockHead) ? b.rockHead : null;
  const etY = y(depth) + 18;
  // The rock head line and its label already give that depth; a bottom label there would be crossed out.
  const onRockHead = (d: number) => rockHead != null && Math.abs(d - rockHead) < 0.005;
  /** True when a layer's label row could run into the R marker. */
  const nearMarker = (l: Layer) =>
    markerY != null && y(l.to) > markerY - MARKER_HALF - 4 && y(l.from) < markerY + MARKER_HALF + 4;
  /** Baseline of a layer's label: mid-layer, or just above the R marker's line when that would cross it. */
  const labelY = (l: Layer) => {
    const mid = y((l.from + l.to) / 2) + 4;
    if (markerY == null || !marker?.stated) return mid;
    return mid > markerY - 4 && mid < markerY + 12 ? markerY - 5 : mid;
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
      <defs>
        <pattern id={NOT_LOGGED_ID} width="8" height="8" patternUnits="userSpaceOnUse">
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

      {/* stratigraphy: the stated name as text on a neutral fill */}
      {strat.map((blk) => {
        const h = (blk.to - blk.from) * s;
        const cy = y((blk.from + blk.to) / 2);
        const across = blk.name && h > 14 ? fitText(blk.name, X.stratW - 4, 10) : '';
        const fitsAcross = !!blk.name && across === blk.name;
        const along = blk.name && !fitsAcross && h > 24 ? fitText(blk.name, h - 6, 10) : '';
        return (
          <g key={`${blk.name ?? ''}-${blk.from}`}>
            <title>{`Stratigraphy: ${blk.name ?? 'not stated'}, ${decimalComma(blk.from)}–${decimalComma(blk.to)} m`}</title>
            <rect x={X.stratX} y={y(blk.from)} width={X.stratW} height={h} fill={STRAT_FILL} stroke={INK} />
            {fitsAcross && (
              <text x={X.stratMid} y={cy + 4} fontSize="10" textAnchor="middle" fill={INK}>{blk.name}</text>
            )}
            {along && (
              <text x={X.stratMid} y={cy + 4} fontSize="10" textAnchor="middle" fill={INK} transform={`rotate(-90 ${X.stratMid} ${cy})`}>
                {along}
              </text>
            )}
          </g>
        );
      })}

      {/* lithology: DIN 4023 patterns, tiles at native size */}
      {b.layers.map((l) => {
        const top = y(l.from);
        const h = (l.to - l.from) * s;
        const unknownCode = l.din && !dinEntry(l.din) ? l.din : null;
        const label = layerLabel(l, nearMarker(l) ? LABEL_MAX_W_NEAR_MARKER : LABEL_MAX_W);
        const select = () => onSelectLayer(l.n);
        return (
          <g
            key={l.n}
            className={styles.hit}
            role="button"
            tabIndex={0}
            aria-label={`Layer ${l.n}: ${l.lithology || 'no description'}, ${decimalComma(l.from)}–${decimalComma(l.to)} m`}
            aria-pressed={l.n === selectedLayer}
            onClick={select}
            onKeyDown={onKeyActivate(select)}
          >
            <title>{layerTitle(l)}</title>
            {dinNeedsUnderlay(l.din) && <rect x={X.layerX} y={top} width={X.layerW} height={h} fill="#fff" />}
            <rect x={X.layerX} y={top} width={X.layerW} height={h} fill={dinFill(l.din)} stroke={INK} data-din={l.din ?? ''} />
            {unknownCode && h > 12 && (
              <text x={X.layerMid} y={y((l.from + l.to) / 2) + 4} fontSize="10" textAnchor="middle" fill={INK}>
                {fitText(unknownCode, X.layerW - 8, 10)}
              </text>
            )}
            <line x1={X.layerX + X.layerW} y1={y(l.to)} x2={X.bottomTickTo} y2={y(l.to)} stroke={INK} />
            {!onRockHead(l.to) && (
              <text x={X.bottomLabel} y={y(l.to) + 4} fontSize="10" fill={INK}>{decimalComma(l.to)}</text>
            )}
            {h > 12 && label && (
              <text x={X.code} y={labelY(l)} fontSize={LABEL_FONT} fontWeight="700" fill={INK}>{label}</text>
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
            fill={`url(#${NOT_LOGGED_ID})`}
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

      {/* first SPT refusal: at its depth, or in the middle of its layer when the source states none */}
      {refusal && marker && markerY != null && (
        <RefusalMarker
          raw={refusal.raw}
          layer={refusal.layer}
          depth={marker.stated ? marker.at : null}
          markerY={markerY}
          layerTop={y(refusal.layer.from)}
          layerBottom={y(refusal.layer.to)}
          onOpen={() => onOpenSource(K.spt(refusal.layer.n))}
        />
      )}
    </svg>
  );
}

interface RefusalProps {
  raw: string;
  layer: Layer;
  /** Stated test depth in m, or null ("depth not stated"). */
  depth: number | null;
  markerY: number;
  layerTop: number;
  layerBottom: number;
  onOpen(): void;
}

/**
 * The amber R marker. A stated depth gets a dashed leader at that depth. Without one, a dotted
 * bracket spans the whole layer and the texts say "depth not stated": no depth is ever printed.
 */
function RefusalMarker({ raw, layer, depth, markerY, layerTop, layerBottom, onOpen }: RefusalProps) {
  const where =
    depth != null
      ? `at ${depth.toFixed(2)} m`
      : `depth not stated (layer ${layer.n}, ${decimalComma(layer.from)}–${decimalComma(layer.to)} m)`;
  const ariaWhere = depth != null ? `at ${depth.toFixed(2)} m` : 'depth not stated';
  const cx = X.refusalX + 11;
  return (
    <g
      className={styles.hit}
      role="button"
      tabIndex={0}
      aria-label={`SPT refusal ${raw} ${ariaWhere}: show source`}
      onClick={onOpen}
      onKeyDown={onKeyActivate(onOpen)}
    >
      <title>{`SPT refusal “${raw}” ${where} — click to see the source`}</title>
      {depth != null ? (
        <line x1={X.layerX + X.layerW} y1={markerY} x2={X.refusalX} y2={markerY} stroke={COL.amber} strokeWidth="1" strokeDasharray="2 2" />
      ) : (
        <path
          d={`M${cx - 4} ${layerTop} H${cx} V${layerBottom} H${cx - 4}`}
          fill="none"
          stroke={COL.amber}
          strokeWidth="1.5"
          strokeDasharray="2 2"
        />
      )}
      <rect x={X.refusalX} y={markerY - MARKER_HALF} width="22" height={MARKER_HALF * 2} rx="2" fill={COL.amber} />
      <text x={cx} y={markerY + 5} fontSize="12" fontWeight="800" textAnchor="middle" fill={INK}>R</text>
    </g>
  );
}

/** A DIN 4023 legend swatch at the native tile size (white underlay for `A`, plain grey without a known code). */
function DinSwatch({ code }: { code: string | null }) {
  return (
    <svg className={styles.swatch} width="36" height="18" aria-hidden="true">
      {dinNeedsUnderlay(code) && <rect width="36" height="18" fill="#fff" />}
      <rect x="0.5" y="0.5" width="35" height="17" fill={dinFill(code)} stroke={COL.border} />
    </svg>
  );
}

/**
 * Legend under the profile: the DIN 4023 codes this profile uses (swatch, code, English name; the
 * German name on hover), the groundwater and SPT refusal marks, and the note "nach DIN 4023".
 */
export function ProfileLegend({ borehole }: { borehole: Borehole }) {
  const items = dinLegendItems(borehole.layers);
  const withoutCode = borehole.layers.some((l) => !l.din);
  return (
    <div className={styles.legend}>
      {(items.length > 0 || withoutCode) && (
        <ul className={styles.dinItems} aria-label="DIN 4023 codes in this profile">
          {items.map(({ code, entry }) => (
            <li
              key={code}
              className={styles.legendItem}
              data-din={code}
              title={entry ? `${code}: ${entry.nameEn} (${entry.nameDe})` : `${code} is not a DIN 4023 code`}
            >
              <DinSwatch code={code} />
              <span className={styles.code}>{code}</span>
              {entry ? entry.nameEn : <span className={styles.unknown}>not a DIN 4023 code</span>}
            </li>
          ))}
          {withoutCode && (
            <li className={styles.legendItem}>
              <DinSwatch code={null} />
              <span className={styles.unknown}>no DIN code in source</span>
            </li>
          )}
        </ul>
      )}
      <div className={styles.marks}>
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
        <span className={styles.note}>nach DIN 4023</span>
      </div>
    </div>
  );
}
