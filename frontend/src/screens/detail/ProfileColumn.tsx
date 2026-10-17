import type { KeyboardEvent, ReactNode } from 'react';
import { dinFill, dinLegendItems, dinNeedsUnderlay } from '../../domain/din';
import { decimal } from '../../domain/format';
import { K } from '../../domain/keys';
import type { Borehole, GroundwaterReading, GroundwaterType, Layer, Sample } from '../../domain/types';
import { useT } from '../../i18n';
import { COL } from '../../theme';
import { GW_LABEL } from './detailModel';
import {
  CORED_PATTERN,
  CORED_W,
  GW_SYMBOL,
  isUnknownCode,
  isWaterSample,
  layerOverlays,
  mainFill,
  PROP_K,
  propertySymbols,
  SAMPLE_SYMBOL,
  secondaryOf,
  type PropertySymbol,
  type SvgSymbol,
} from './dinPatterns';
import {
  depthScale,
  depthTicks,
  firstRefusal,
  fitText,
  isStated,
  LABEL_FONT,
  layerLabel,
  notLogged,
  PROFILE_H,
  PROFILE_TOP,
  PROFILE_W,
  refusalMarkerDepth,
  sampleDepth,
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
  /** The picked sample (index into `borehole.samples`): its marker is outlined. */
  selectedSample?: number | null;
  onSelectSample?(i: number): void;
  /** A drawing only (the printable sheet): nothing in it is a button. */
  readOnly?: boolean;
  /** Translates the drawing's few words; the app's UI language when left out (the sheet passes its own). */
  t?: (en: string) => string;
}

const INK = COL.text;
/** The Strat. column is neutral: the name is the information, there is no colour table. */
const STRAT_FILL = '#F4F4F4';
/** Hatching of the "not logged" band (a UI mark, not a DIN pattern). */
const NOT_LOGGED_ID = 'bp-nl';
/** Clip of the Table 6 strip, so a layer with many properties never runs into the depth labels. */
const PROP_CLIP_ID = 'bp-prop';
/** Room for a layer label right of the column, and next to the R marker. */
const LABEL_MAX_W = PROFILE_W - X.code - 4;
const LABEL_MAX_W_NEAR_MARKER = X.refusalX - X.code - 8;
/** Half the height of the R marker badge, px. */
const MARKER_HALF = 9;
/** Width of a groundwater symbol in the profile, px. */
const GW_W = 12;

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
  const unknown = isUnknownCode(l.din) ? ` (${l.din} is not a DIN 4023 code: no pattern assigned)` : '';
  const printed = l.lithologyAsPrinted ? `\nas printed: “${l.lithologyAsPrinted}”` : '';
  return `Layer ${l.n} · ${code}${unknown} · ${l.lithology || 'no description'}${printed}`;
}

type StatedReading = GroundwaterReading & { depth: number };

/** A DIN 4023 symbol file drawn once, `w` px wide, its bottom edge at `bottom` (groundwater tip, sample depth). */
function Symbol({ sym, x, bottom, w, color }: { sym: SvgSymbol; x: number; bottom: number; w: number; color?: string }) {
  const h = (sym.h * w) / sym.w;
  const inner = color ? sym.inner.replaceAll('#000', color) : sym.inner;
  return <svg x={x} y={bottom - h} width={w} height={h} viewBox={`0 0 ${sym.w} ${sym.h}`} dangerouslySetInnerHTML={{ __html: inner }} />;
}

/** One Table 6 symbol over a layer's height: a repeating tile, or the single wet mark; weathering adds its edges. */
function PropertyMark({ p, x, top, h }: { p: PropertySymbol; x: number; top: number; h: number }) {
  return (
    <g transform={`translate(${x},${top})`} data-prop={p.key}>
      <title>{p.label}</title>
      {p.patternId ? (
        <rect width={p.w} height={h} fill={`url(#${p.patternId})`} />
      ) : (
        <svg width={p.w} height={Math.min(p.h, h)} viewBox={`0 0 ${p.w / PROP_K} ${p.h / PROP_K}`} dangerouslySetInnerHTML={{ __html: p.markup ?? '' }} />
      )}
      {p.frame != null && (
        <>
          <rect width={p.w} height={p.frame} fill={INK} />
          <rect y={h - p.frame} width={p.w} height={p.frame} fill={INK} />
        </>
      )}
    </g>
  );
}

/**
 * DIN 4023 borehole profile: depth axis with ticks, Strat. column (stratigraphic names), lithology
 * column filled with the DIN 4023 patterns of assets/din4023_patterns (main tile, first secondary
 * component, two equal parts; layers clickable), the Table 6 strip right of it (wet, consistency /
 * density, weathering), the Table 5 lane left of it (groundwater symbols, sample markers, the cored
 * line), "not logged" band, ET label, rock head, selection and the amber R marker of the first SPT
 * refusal (groundwater and R open the Source panel).
 *
 * The patterns come from DinPatternDefs, mounted once in the app. A known code fills with
 * `url(#<pattern_id>)` at the native tile size; `A` gets a white underlay; an unknown code is solid
 * red, labelled "no pattern assigned"; a layer without a code is plain #E0E0E0. A property the record
 * leaves empty is not drawn (never a default).
 */
export function ProfileColumn({
  borehole: b,
  selectedLayer,
  onSelectLayer,
  onOpenSource,
  selectedSample = null,
  onSelectSample,
  readOnly = false,
  t: tProp,
}: Props) {
  const appT = useT();
  const t = tProp ?? appT;
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
  const samples = b.samples.map((sm, i) => ({ sm, i, at: sampleDepth(sm) })).filter((x): x is { sm: Sample; i: number; at: number } => x.at != null);
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
  /** Button props of a clickable mark; none on the read-only sheet. */
  const button = (label: string, fn: () => void, pressed?: boolean) =>
    readOnly
      ? {}
      : {
          className: styles.hit,
          role: 'button',
          tabIndex: 0,
          'aria-label': label,
          ...(pressed != null ? { 'aria-pressed': pressed } : {}),
          onClick: fn,
          onKeyDown: onKeyActivate(fn),
        };

  return (
    <svg
      className={styles.svg}
      width={PROFILE_W}
      height={PROFILE_H}
      viewBox={`0 0 ${PROFILE_W} ${PROFILE_H}`}
      // A group, not an img: an img's children are presentational, and the layers, GW symbols,
      // sample markers and the R marker inside are buttons.
      role="group"
      aria-label={`DIN 4023 profile of ${b.id}, ${b.layers.length} layers, final depth ${b.finalDepth != null ? `${decimal(b.finalDepth)} m` : 'not stated'}`}
    >
      <defs>
        <pattern id={NOT_LOGGED_ID} width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M0 8 L8 0" stroke={COL.border} strokeWidth="1" />
        </pattern>
        <clipPath id={PROP_CLIP_ID}>
          <rect x={X.propX} y={0} width={X.propW + 4} height={PROFILE_H} />
        </clipPath>
      </defs>

      <text x={X.stratMid} y="18" fontSize="10" fill={COL.faint} textAnchor="middle">{t('Strat.')}</text>
      <text x={X.layerMid} y="18" fontSize="10" fill={COL.faint} textAnchor="middle">{t('Lithology')}</text>

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
            <title>{`Stratigraphy: ${blk.name ?? 'not stated'}, ${decimal(blk.from)}–${decimal(blk.to)} m`}</title>
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

      {/* lithology: DIN 4023 patterns at native tile size, secondary components, Table 6 strip, cored line */}
      {b.layers.map((l) => {
        const top = y(l.from);
        const h = (l.to - l.from) * s;
        const unknownCode = isUnknownCode(l.din);
        const label = layerLabel(l, nearMarker(l) ? LABEL_MAX_W_NEAR_MARKER : LABEL_MAX_W);
        const select = () => onSelectLayer(l.n);
        let px = X.propX; // next free x in the Table 6 strip
        return (
          <g
            key={l.n}
            {...button(`Layer ${l.n}: ${l.lithology || 'no description'}, ${decimal(l.from)}–${decimal(l.to)} m`, select, l.n === selectedLayer)}
          >
            <title>{layerTitle(l)}</title>
            {/* the whole band from the column to the depth labels is the button, the Table 6 strip's gaps included */}
            {!readOnly && <rect x={X.layerX} y={top} width={X.bottomTickTo - X.layerX} height={h} fill="transparent" />}
            {dinNeedsUnderlay(l.din) &&<rect x={X.layerX} y={top} width={X.layerW} height={h} fill="#fff" />}
            <rect x={X.layerX} y={top} width={X.layerW} height={h} fill={mainFill(l.din)} data-din={l.din ?? ''} />
            {layerOverlays(l).map((f, j) => (
              <rect key={j} x={X.layerX + f.x0 * X.layerW} y={top} width={(f.x1 - f.x0) * X.layerW} height={h} fill={f.fill}>
                <title>{f.title}</title>
              </rect>
            ))}
            <rect x={X.layerX} y={top} width={X.layerW} height={h} fill="none" stroke={INK} />
            {unknownCode && h > 12 && (
              <text x={X.layerMid} y={y((l.from + l.to) / 2) + 3} fontSize="9" fontWeight="700" textAnchor="middle" fill="#fff">
                {t('no pattern assigned')}
              </text>
            )}
            {/* cored section (Table 5): the double line left of the column */}
            {l.isCore === true && (
              <g transform={`translate(${X.layerX - CORED_W - 2},${top})`} data-cored="">
                <title>Cored</title>
                <rect width={CORED_W} height={h} fill={`url(#${CORED_PATTERN})`} />
              </g>
            )}
            {/* Table 6: side by side right of the column, each over the layer's height */}
            <g clipPath={`url(#${PROP_CLIP_ID})`}>
              {propertySymbols(l).map((p) => {
                const x = px;
                px += p.w + 2;
                return <PropertyMark key={p.key} p={p} x={x} top={top} h={h} />;
              })}
            </g>
            <line x1={X.layerX + X.layerW} y1={y(l.to)} x2={X.bottomTickTo} y2={y(l.to)} stroke={INK} />
            {!onRockHead(l.to) && (
              <text x={X.bottomLabel} y={y(l.to) + 4} fontSize="10" fill={INK}>{decimal(l.to)}</text>
            )}
            {h > 12 && label && (
              <text x={X.code} y={labelY(l)} fontSize={LABEL_FONT} fontWeight="700" fill={INK}>{label}</text>
            )}
          </g>
        );
      })}

      {b.layers.length === 0 && (
        <text x={X.layerMid} y={PROFILE_TOP + 40} fontSize="11" textAnchor="middle" fill={COL.faint} fontStyle="italic">
          {t('no layers in source')}
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
          <text x={X.layerMid} y={y((nl.from + nl.to) / 2) + 4} fontSize="10" textAnchor="middle" fill={COL.muted}>{t('not logged')}</text>
          <text x={X.bottomLabel} y={y((nl.from + nl.to) / 2) + 4} fontSize="10" fill={COL.red}>{nl.label}</text>
        </g>
      )}

      <text x={X.layerMid} y={etY} fontSize="10" textAnchor="middle" fill={INK}>
        {b.finalDepth != null && b.finalDepth > 0 ? `ET ${decimal(b.finalDepth)} m` : t('ET not stated')}
      </text>

      {/* rock head */}
      {rockHead != null && (
        <g>
          <title>{`Rock head ${decimal(rockHead)} m`}</title>
          <line x1={X.rockFrom} y1={y(rockHead)} x2={X.rockTo} y2={y(rockHead)} stroke={COL.dark} strokeWidth="1.5" strokeDasharray="6 3" />
          <text x={X.code} y={y(rockHead) + 14} fontSize="10" fill={COL.dark} fontWeight="700">
            {`${t('rock head')} ${decimal(rockHead)}`}
          </text>
        </g>
      )}

      {/* selected layer */}
      {sel && !readOnly && (
        <rect
          className={styles.noHit}
          x={X.layerX - 2}
          y={y(sel.from) - 2}
          width={X.layerW + 4}
          height={(sel.to - sel.from) * s + 4}
          fill="none"
          stroke={INK}
          strokeWidth="3"
        />
      )}

      {/* groundwater (Table 5): struck ▽, rest level half filled, standpipe ▼; a click opens the source */}
      {groundwater.map((g) => {
        const gy = y(g.depth);
        const label = `GW ${GW_LABEL[g.type].toLowerCase()} ${g.depth.toFixed(2)} m`;
        const open = () => onOpenSource(g.key);
        return (
          <g key={g.key} {...button(`${label}: show source`, open)} data-gw={g.type}>
            <title>{label}</title>
            {/* invisible click area around the level: the line alone is too thin to hit */}
            {!readOnly && <rect x={X.gwFrom} y={gy - 15} width={X.layerX - X.gwFrom} height={19} fill="transparent" />}
            <line x1={X.gwFrom} y1={gy} x2={X.layerX} y2={gy} stroke={COL.gw} strokeWidth="1.5" />
            <Symbol sym={GW_SYMBOL[g.type]} x={X.gwX} bottom={gy} w={GW_W} color={COL.gw} />
          </g>
        );
      })}

      {/* samples (Table 5): box = sample, open triangle = water sample; bottom edge at the sample depth */}
      {samples.map(({ sm, i, at }) => {
        const sym = SAMPLE_SYMBOL[isWaterSample(sm) ? 'water' : 'soil'];
        const h = (sym.h * X.sampleW) / sym.w;
        const sy = y(at);
        const picked = i === selectedSample;
        const label = `${isWaterSample(sm) ? 'Water sample' : 'Sample'} ${sm.name || ''} at ${at.toFixed(2)} m`.replace('  ', ' ');
        const pick = () => onSelectSample?.(i);
        return (
          <g key={sm.key} {...(onSelectSample ? button(label, pick, picked) : {})} data-sample={sm.name}>
            <title>{label}</title>
            {!readOnly && onSelectSample && (
              <rect x={X.sampleX - 3} y={sy - h - 3} width={X.layerX - X.sampleX + 3} height={h + 6} fill="transparent" />
            )}
            <line x1={X.sampleX + X.sampleW} y1={sy} x2={X.layerX} y2={sy} stroke={INK} strokeWidth="1" />
            <Symbol sym={sym} x={X.sampleX} bottom={sy} w={X.sampleW} />
            {picked && (
              <rect className={styles.noHit} x={X.sampleX - 2} y={sy - h - 2} width={X.sampleW + 4} height={h + 4} fill="none" stroke={INK} strokeWidth="1.5" />
            )}
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
          button={button}
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
  button(label: string, fn: () => void): object;
  onOpen(): void;
}

/**
 * The amber R marker. A stated depth gets a dashed leader at that depth. Without one, a dotted
 * bracket spans the whole layer and the texts say "depth not stated": no depth is ever printed.
 */
function RefusalMarker({ raw, layer, depth, markerY, layerTop, layerBottom, button, onOpen }: RefusalProps) {
  const where =
    depth != null
      ? `at ${depth.toFixed(2)} m`
      : `depth not stated (layer ${layer.n}, ${decimal(layer.from)}–${decimal(layer.to)} m)`;
  const ariaWhere = depth != null ? `at ${depth.toFixed(2)} m` : 'depth not stated';
  const cx = X.refusalX + 11;
  return (
    <g {...button(`SPT refusal ${raw} ${ariaWhere}: show source`, onOpen)}>
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

/** A legend swatch at the native tile size: a DIN fill (white underlay for `A`), or any other drawing. */
function Swatch({ children, w = 36, h = 18 }: { children: ReactNode; w?: number; h?: number }) {
  return (
    <svg className={styles.swatch} width={w} height={h} aria-hidden="true">
      {children}
    </svg>
  );
}

/** The DIN fill of a code as a legend swatch: its tile, solid red for an unknown code, plain grey without one. */
function DinSwatch({ code }: { code: string | null }) {
  const fill = isUnknownCode(code) ? COL.red : dinFill(code);
  return (
    <Swatch>
      {dinNeedsUnderlay(code) && <rect width="36" height="18" fill="#fff" />}
      <rect x="0.5" y="0.5" width="35" height="17" fill={fill} stroke={COL.border} />
    </Swatch>
  );
}

/** A groundwater symbol for the legend. */
function GwSwatch({ type }: { type: GroundwaterType }) {
  return (
    <Swatch w={GW_W} h={12}>
      <Symbol sym={GW_SYMBOL[type]} x={0} bottom={12} w={GW_W} color={COL.gw} />
    </Swatch>
  );
}

/**
 * Legend under the profile: the DIN 4023 codes this profile uses (swatch, code, English name; the
 * German name on hover; unknown codes red, "no pattern assigned"), the secondary components and
 * Table 6 properties it draws, and the marks it shows (groundwater per reading type, samples,
 * cored, SPT refusal), with the note "nach DIN 4023".
 */
export function ProfileLegend({
  borehole,
  readOnly = false,
  de = false,
  t: tProp,
}: {
  borehole: Borehole;
  readOnly?: boolean;
  /** DIN names in German (the German sheet). */
  de?: boolean;
  t?: (en: string) => string;
}) {
  const appT = useT();
  const t = tProp ?? appT;
  const items = dinLegendItems(borehole.layers);
  const withoutCode = borehole.layers.some((l) => !l.din);
  const secondary = new Map(borehole.layers.map(secondaryOf).filter((x) => x != null).map((x) => [x.code, x]));
  const props = new Map(borehole.layers.flatMap(propertySymbols).map((p) => [p.key, p]));
  const gwTypes = [...new Set(borehole.groundwater.filter((g) => g.depth != null).map((g) => g.type))];
  const sampleKinds = new Set(borehole.samples.filter((sm) => sampleDepth(sm) != null).map((sm) => (isWaterSample(sm) ? 'water' : 'soil')));
  const cored = borehole.layers.some((l) => l.isCore === true);
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
              {entry ? (de ? entry.nameDe : entry.nameEn) : <span className={styles.unknown}>{t('no pattern assigned')}</span>}
            </li>
          ))}
          {withoutCode && (
            <li className={styles.legendItem}>
              <DinSwatch code={null} />
              <span className={styles.unknown}>{t('no DIN code in source')}</span>
            </li>
          )}
        </ul>
      )}
      {(secondary.size > 0 || props.size > 0) && (
        <ul className={styles.dinItems} aria-label="Secondary components and properties">
          {[...secondary.values()].map((sc) => (
            <li key={sc.code} className={styles.legendItem} title={`${sc.code}: ${sc.nameEn} (${sc.nameDe})`}>
              <Swatch>
                <rect x="0.5" y="0.5" width="35" height="17" fill={`url(#${sc.patternId})`} stroke={COL.border} />
              </Swatch>
              <span className={styles.code}>{sc.code}</span>
              {de ? sc.nameDe : sc.nameEn}
            </li>
          ))}
          {[...props.values()].map((p) => (
            <li key={p.key} className={styles.legendItem} title={`${p.label} (${p.labelDe})`} data-prop={p.key}>
              <Swatch w={Math.ceil(p.w)} h={18}>
                <PropertyMark p={p} x={0} top={0} h={18} />
              </Swatch>
              {de ? p.labelDe : p.label}
            </li>
          ))}
        </ul>
      )}
      <div className={styles.marks}>
        {gwTypes.map((type) => (
          <span key={type} className={styles.legendItem}>
            <GwSwatch type={type} />
            {t(`GW ${GW_LABEL[type].toLowerCase()}`)}
          </span>
        ))}
        {[...sampleKinds].map((kind) => (
          <span key={kind} className={styles.legendItem}>
            <Swatch w={X.sampleW} h={12}>
              <Symbol sym={SAMPLE_SYMBOL[kind]} x={0} bottom={12} w={X.sampleW} />
            </Swatch>
            {t(kind === 'water' ? 'water sample' : 'sample')}
          </span>
        ))}
        {cored && (
          <span className={styles.legendItem}>
            <Swatch w={Math.ceil(CORED_W)} h={18}>
              <rect width={CORED_W} height={18} fill={`url(#${CORED_PATTERN})`} />
            </Swatch>
            {t('cored')}
          </span>
        )}
        <span className={styles.legendItem}>
          <span className={styles.rBadge}>R</span>
          {t(readOnly ? 'SPT refusal' : 'SPT refusal (click)')}
        </span>
        <span className={styles.note}>nach DIN 4023</span>
      </div>
    </div>
  );
}
