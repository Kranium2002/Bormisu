import { useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { K } from '../../domain/keys';
import type { Borehole, GroundwaterReading, Layer } from '../../domain/types';
import { COL, STRAT_COLORS, STRAT_FALLBACK } from '../../theme';
import { GW_LABEL } from './detailModel';
import { CORED_PATTERN, CORED_W, explainLayer, explainProperty, GW_SYMBOL, layerFill, MISSING_PATTERN, patternDefs, PROP_K, propertySymbols } from './dinPatterns';
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

/** The explanation bubble: what was clicked, where (px in the profile), for which borehole. */
interface Tip { uid: string; x: number; y: number; text: string }

/**
 * DIN 4023 borehole profile: depth axis with ticks, Strat. column, hatched lithology column
 * (layers clickable), "not logged" band, ET label, rock head, selection, groundwater triangles
 * and the amber R marker of the first SPT refusal (both open the Source panel).
 * No legend: clicking any part shows what it means in a bubble next to it.
 */
export function ProfileColumn({ borehole: b, selectedLayer, onSelectLayer, onOpenSource }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  /** Shows `text` under the clicked element (mouse or keyboard); a click on the explanation's own owner keeps it. */
  const explain = (text: string) => (e: MouseEvent | KeyboardEvent) => {
    e.stopPropagation();
    const box = (e.currentTarget as Element).getBoundingClientRect();
    const at = wrap.current!.getBoundingClientRect();
    setTip({ uid: b.uid, x: box.left + box.width / 2 - at.left, y: box.bottom - at.top, text });
  };
  /** A non-interactive part made clickable for its explanation (also from the keyboard). */
  const explainable = (text: string, label: string) => ({
    className: styles.hit, role: 'button', tabIndex: 0, 'aria-label': `${label}: what is this?`,
    onClick: explain(text), onKeyDown: (e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), explain(text)(e)),
  });
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

  const shown = tip?.uid === b.uid ? tip : null;
  return (
    <div ref={wrap} className={styles.wrap}>
    <svg
      onClick={() => setTip(null)}
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
          <g key={`${blk.code}-${blk.from}`} {...explainable(
            `${blk.code || 'No code'}: stratigraphic unit as printed in the log, ${blk.from.toFixed(2)}–${blk.to.toFixed(2)} m.`,
            `Stratigraphy ${blk.code || 'not stated'}`)}>
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
        const select = (e: MouseEvent | KeyboardEvent) => {
          onSelectLayer(l.n);
          explain(`Layer ${l.n}, ${l.from.toFixed(2)}–${l.to.toFixed(2)} m: ${explainLayer(l)}`)(e);
        };
        return (
          <g
            key={l.n}
            className={styles.hit}
            role="button"
            tabIndex={0}
            aria-label={`Layer ${l.n}: ${l.lithology}, ${l.from.toFixed(2)}–${l.to.toFixed(2)} m`}
            aria-pressed={l.n === selectedLayer}
            onClick={select}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), select(e))}
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
              <g transform={`translate(${X.layerX - CORED_W - 2},${top})`}
                {...explainable('Cored section: a drill core was taken over this layer (DIN 4023 Table 5).', 'Cored section')}>
                <title>Cored</title>
                <rect width={CORED_W} height={h} fill={`url(#${CORED_PATTERN})`} />
              </g>
            )}
            {/* Table 6 symbols side by side right of the column, each repeated over the layer's height */}
            {props[i].map((p) => {
              const x = px;
              px += p.w + 2;
              return (
                <g key={p.key} transform={`translate(${x},${top})`} {...explainable(explainProperty(p), p.label)}>
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
        <g {...explainable(`Not logged, ${nl.from.toFixed(2)}–${nl.to.toFixed(2)} m: the log stops above the final depth. A sheet may be missing.`, 'Not logged')}>
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

      <g {...explainable('ET (Endteufe): the final depth of the borehole.', 'Final depth')}>
        <text x={X.layerMid} y={etY} fontSize="10" textAnchor="middle" fill={INK}>
          {b.finalDepth != null && b.finalDepth > 0 ? `ET ${b.finalDepth.toFixed(2)} m` : 'ET not stated'}
        </text>
      </g>

      {/* rock head */}
      {rockHead != null && (
        <g {...explainable(`Rock head at ${rockHead.toFixed(2)} m: the top of the rock, soil above.`, 'Rock head')}>
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
            <GwSymbol type={g.type} x={90} tipY={gy} />
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
    {shown && (
      <div className={styles.tip} role="status" style={{ left: Math.min(Math.max(shown.x, 110), PROFILE_W - 110), top: shown.y + 6 }}>
        {shown.text}
      </div>
    )}
    </div>
  );
}
