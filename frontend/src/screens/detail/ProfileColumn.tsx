import type { KeyboardEvent } from 'react';
import { K } from '../../domain/keys';
import type { Borehole, GroundwaterReading, Layer } from '../../domain/types';
import { COL, STRAT_COLORS, STRAT_FALLBACK } from '../../theme';
import { GW_LABEL } from './detailModel';
import { CORED_PATTERN, CORED_W, GW_SYMBOL, layerFill, MISSING_PATTERN, patternDefs, PROP_K, propertySymbols, SAMPLE_SYMBOL } from './dinPatterns';
import {
  depthScale,
  depthTicks,
  drawnMarks,
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
  /** The picked groundwater reading (key): its triangle is outlined, its GROUNDWATER row highlighted. */
  selectedGw: string | null;
  onSelectGw(key: string): void;
  /** The picked sample (index into testResults): its marker is outlined, its TEST RESULTS row highlighted. */
  selectedTest: number | null;
  onSelectTest(i: number): void;
}

const INK = COL.text;
/** Hatching of the "not logged" band; the layers use the DIN 4023 patterns (dinPatterns.ts). */
const NL_PATTERN = 'bp-nl';

/** DIN 4023 groundwater symbol (Table 5), 12 px wide, tip on the water level, in the groundwater blue. */
function GwSymbol({ type, x, tipY }: { type: GroundwaterReading['type']; x: number; tipY: number }) {
  const sym = GW_SYMBOL[type];
  const h = (sym.h * 12) / sym.w;
  return (
    <svg x={x} y={tipY - h} width={12} height={h} viewBox={`0 0 ${sym.w} ${sym.h}`}
      dangerouslySetInnerHTML={{ __html: sym.inner.replaceAll('#000', COL.gw) }} />
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
export function ProfileColumn({ borehole: b, selectedLayer, onSelectLayer, onOpenSource, selectedGw, onSelectGw, selectedTest, onSelectTest }: Props) {
  const { depth, s, y } = depthScale(b);
  const ticks = depthTicks(depth);
  const strat = stratBlocks(b.layers);
  const nl = notLogged(b);
  const sel = b.layers.find((l) => l.n === selectedLayer);
  // Measurements the reviewer marked "not in source" / "illegible" aren't drawn.
  const { refusal, groundwater, rockHead } = drawnMarks(b);
  const etY = y(depth) + 18;
  const fills = b.layers.map(layerFill);
  const props = b.layers.map((l) => propertySymbols(l.props));
  const defIds = [...fills.flat().map((f) => f.patternId), ...props.flat().map((p) => p.patternId), CORED_PATTERN];
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
      <defs dangerouslySetInnerHTML={{ __html: patternDefs(defIds) }} />
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
        const missing = fills[i].some((f) => f.patternId === MISSING_PATTERN);
        const top = y(l.from);
        let px = X.propX;  // next free x in the Table 6 strip
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
            <title>{`Layer ${l.n} · ${l.din} · ${l.lithology}${missing ? ` · no DIN 4023 pattern for "${l.din}"` : ''}`}</title>
            {/* white under the tile: "A" (fill) has no DIN colour; nothing named: plain #E0E0E0 (README) */}
            <rect x={X.layerX} y={top} width={X.layerW} height={h} fill={fills[i].length ? '#fff' : '#E0E0E0'} />
            {fills[i].map((f, j) => (
              <rect key={j} x={X.layerX + f.x0 * X.layerW} y={top} width={(f.x1 - f.x0) * X.layerW} height={h} fill={f.fill} />
            ))}
            <rect x={X.layerX} y={top} width={X.layerW} height={h} fill="none" stroke={INK} />
            {/* cored section: double line left of the column (Table 5) */}
            {l.props?.core && (
              <g transform={`translate(${X.layerX - CORED_W - 2},${top})`}>
                <title>Cored</title>
                <rect width={CORED_W} height={h} fill={`url(#${CORED_PATTERN})`} />
              </g>
            )}
            {/* Table 6 symbols side by side right of the column, each repeated over the layer's height */}
            {props[i].map((p) => {
              const x = px;
              px += p.w + 2;
              return (
                <g key={p.key} transform={`translate(${x},${top})`}>
                  <title>{p.label}</title>
                  {p.patternId ? <rect width={p.w} height={h} fill={`url(#${p.patternId})`} />
                    : <svg width={p.w} height={Math.min(p.h, h)} viewBox={`0 0 ${p.w / PROP_K} ${p.h / PROP_K}`} dangerouslySetInnerHTML={{ __html: p.markup! }} />}
                  {p.frame != null && (
                    <>
                      <rect width={p.w} height={p.frame} fill={INK} />
                      <rect y={h - p.frame} width={p.w} height={p.frame} fill={INK} />
                    </>
                  )}
                </g>
              );
            })}
            {missing && h > 12 && (
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
          stroke={COL.accent}
          strokeWidth="3"
        />
      )}

      {/* groundwater (Table 5): a click picks the reading, its GROUNDWATER row highlights */}
      {groundwater.map((g) => {
        const gy = y(g.depth);
        const label = `GW ${GW_LABEL[g.type].toLowerCase()} ${g.depth.toFixed(2)} m`;
        const sel = g.key === selectedGw;
        const pick = () => onSelectGw(g.key);
        return (
          <g
            key={g.key}
            className={styles.hit}
            role="button"
            tabIndex={0}
            aria-label={label}
            aria-pressed={sel}
            onClick={pick}
            onKeyDown={onKeyActivate(pick)}
          >
            <title>{label}</title>
            <line x1={X.gwFrom} y1={gy} x2={X.layerX} y2={gy} stroke={COL.gw} strokeWidth={sel ? 3 : 1.5} />
            <GwSymbol type={g.type} x={X.gwX} tipY={gy} />
            {sel && <rect className={styles.noHit} x={X.gwX - 2} y={gy - 13} width={16} height={15} fill="none" stroke={COL.accent} strokeWidth="1.5" />}
          </g>
        );
      })}

      {/* samples (Table 5): box = soil, open triangle = water; bottom edge at the sample depth, line to the column */}
      {(b.testResults ?? []).map((r, i) => {
        if (r.depth == null) return null;
        const sym = SAMPLE_SYMBOL[r.sampleType === 'water' ? 'water' : 'soil'];
        const h = (sym.h * X.sampleW) / sym.w;
        const sy = y(r.depth);
        const sel = i === selectedTest;
        const label = `${r.sampleType === 'water' ? 'Water sample' : 'Sample'} ${r.sampleName ?? ''} at ${r.depth.toFixed(2)} m`.replace('  ', ' ');
        const pick = () => onSelectTest(i);
        return (
          <g key={`s${i}`} className={styles.hit} role="button" tabIndex={0} aria-label={label} aria-pressed={sel}
            onClick={pick} onKeyDown={onKeyActivate(pick)}>
            <title>{label}</title>
            <line x1={X.sampleX + X.sampleW} y1={sy} x2={X.layerX} y2={sy} stroke={INK} strokeWidth="1" />
            <svg x={X.sampleX} y={sy - h} width={X.sampleW} height={h} viewBox={`0 0 ${sym.w} ${sym.h}`}
              dangerouslySetInnerHTML={{ __html: sym.inner }} />
            {sel && <rect className={styles.noHit} x={X.sampleX - 2} y={sy - h - 2} width={X.sampleW + 4} height={h + 4} fill="none" stroke={COL.accent} strokeWidth="1.5" />}
          </g>
        );
      })}

      {/* first SPT refusal */}
      {refusal && (
        <line
          className={styles.noHit}
          x1={X.layerX + X.layerW}
          y1={y(refusal.depth)}
          x2={X.refusalX}
          y2={y(refusal.depth)}
          stroke={COL.amber}
          strokeWidth="1"
          strokeDasharray="2 2"
        />
      )}
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
          <rect x={X.refusalX} y={y(refusal.depth) - 9} width="22" height="18" rx="2" fill={COL.amber} />
          <text x={X.refusalX + 11} y={y(refusal.depth) + 5} fontSize="12" fontWeight="800" textAnchor="middle" fill={INK}>R</text>
        </g>
      )}
    </svg>
  );
}
