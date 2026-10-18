/**
 * A chart drawn as inline SVG (the DIN 4023 profile) as a stand-alone image: a PNG for the clipboard
 * or a download, or the SVG itself. Native only: the live <svg> is cloned and serialised, then
 * rasterised through an Image onto a canvas, so text and hatches stay vector-sharp at any scale (no
 * DOM screenshot).
 *
 * The clone loses the page around it, so the export adds back what it needs:
 * - the `<pattern>`s it fills with by `url(#…)` (the shared DinPatternDefs), copied into its own defs,
 * - the font, from the chart's computed style, and any `var(--…)` resolved to a value,
 * - a caption (borehole name, depth note) above and a legend of the fills it shows below.
 * Hover titles, hit areas, selection outlines (`data-export="skip"`), classes and ARIA are dropped:
 * the image always has the plain print look, whatever is selected or focused on screen.
 */
import { fitText } from '../screens/detail/profileGeometry';
import { fileSlug } from './download';

const SVG_NS = 'http://www.w3.org/2000/svg';
const INK = '#111111';
const MUTED = '#555555';
const SWATCH_BORDER = '#D4D4D4';
/** Font when the chart's computed style has none (tests, detached nodes). */
const FALLBACK_FONT = 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif';

/** Raster scale of the PNG: 4 × the on-screen size (the 414 px profile becomes 1656 px, over 300 dpi at 12 cm). */
export const PNG_SCALE = 4;

/** One legend row of the export: a swatch filled like the chart (`url(#…)` or a colour), its code and name. */
export interface ChartLegendEntry {
  fill: string;
  /** White under the fill (a pattern drawn on white, e.g. DIN `A`). */
  underlay?: boolean;
  code: string;
  name: string;
}

/** What the export adds around the drawing. */
export interface ChartExportInfo {
  /** Bold first line: the borehole name and the chart ("BH-AB01 · DIN 4023 profile"). */
  caption: string;
  /** Second line: project, depth reference with its unit. */
  subtitle?: string;
  /** Unit written over the depth axis, at `axisUnitAt` in the drawing's coordinates. */
  axisUnit?: { text: string; x: number; y: number };
  legend: ChartLegendEntry[];
  /** Right-aligned small print under the legend ("nach DIN 4023"). */
  note?: string;
  /** Base of the file name, e.g. the borehole name; sanitised by chartFileName. */
  fileBase: string;
}

/** A built export: its SVG and its size in CSS px; see chartMarkup. */
export interface ChartSvg {
  svg: SVGSVGElement;
  width: number;
  height: number;
}

/** The export's SVG markup, `scale` × its size (the viewBox stays, so it draws the same, larger). */
export function chartMarkup(chart: ChartSvg, scale = 1): string {
  chart.svg.setAttribute('width', String(Math.round(chart.width * scale)));
  chart.svg.setAttribute('height', String(Math.round(chart.height * scale)));
  return new XMLSerializer().serializeToString(chart.svg);
}

/**
 * File name of a chart export: the base as a safe ASCII slug (fileSlug: "BH AB/01" → "BH_AB_01",
 * "Bohrung Ü1" → "Bohrung_U1"), at most 80 characters, then `_profile.<ext>`; "borehole" when nothing
 * is left.
 */
export function chartFileName(base: string, ext: 'png' | 'svg', suffix = 'profile'): string {
  return `${fileSlug(base, 'borehole', 80)}_${suffix}.${ext}`;
}

const URL_REF = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/g;

/** Ids an element and its subtree point at: `url(#id)` in any attribute, `href="#id"`. */
export function referencedIds(root: Element): Set<string> {
  const ids = new Set<string>();
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const a of el.attributes) {
      for (const m of a.value.matchAll(URL_REF)) ids.add(m[1]);
      if (a.localName === 'href' && a.value.startsWith('#')) ids.add(a.value.slice(1));
    }
  }
  return ids;
}

/** `var(--name)` / `var(--name, fallback)` replaced by the variable's value (or the fallback). */
export function resolveVars(value: string, lookup: (name: string) => string): string {
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name: string, fallback?: string) => lookup(name).trim() || fallback?.trim() || '');
}

const DROP_ATTRS = new Set(['class', 'role', 'tabindex', 'style', 'focusable']);

/**
 * The drawing as a stand-alone node: a deep clone without hover titles, hit areas (transparent
 * rects), skipped marks (`data-export="skip"`), classes, ARIA and data attributes, with every
 * `var(--…)` resolved.
 */
function cleanClone(svg: SVGSVGElement, lookupVar: (name: string) => string): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll('title, [data-export="skip"], rect[fill="transparent"]').forEach((el) => el.remove());
  for (const el of [clone, ...clone.querySelectorAll('*')]) {
    for (const a of [...el.attributes]) {
      if (DROP_ATTRS.has(a.name) || a.name.startsWith('aria-') || a.name.startsWith('data-')) el.removeAttribute(a.name);
      else if (a.value.includes('var(')) el.setAttribute(a.name, resolveVars(a.value, lookupVar));
    }
  }
  return clone;
}

/**
 * The `<defs>` the clone needs from the page: every element it references by id that it doesn't
 * define itself, and what those reference in turn, as clones.
 */
function inlinedDefs(clone: Element, lookup: (id: string) => Element | null): Element[] {
  const own = new Set([...clone.querySelectorAll('[id]')].map((e) => e.id));
  const out: Element[] = [];
  const queue = [...referencedIds(clone)];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id) || own.has(id)) continue;
    seen.add(id);
    const def = lookup(id);
    if (!def) continue;
    const copy = def.cloneNode(true) as Element;
    out.push(copy);
    queue.push(...referencedIds(copy));
  }
  return out;
}

const el = (tag: string, attrs: Record<string, string | number>, text?: string) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
};

const PAD = 14;
const CAPTION_SIZE = 15;
const SUB_SIZE = 11;
const ROW_H = 22;
const SWATCH_W = 36;
const SWATCH_H = 16;

export interface BuildOptions {
  /** Looks up a referenced def by id; the page's elements by default. */
  lookup?: (id: string) => Element | null;
  /** Value of a CSS variable; the document's computed style by default. */
  lookupVar?: (name: string) => string;
  /** Font of the drawing; the chart's computed font-family by default. */
  font?: string;
}

/**
 * The export as SVG: white page, caption and subtitle, the cleaned drawing (with the axis
 * unit), the legend in one or two columns and the note, the referenced patterns inlined.
 */
export function buildChartSvg(svg: SVGSVGElement, info: ChartExportInfo, opts: BuildOptions = {}): ChartSvg {
  const rootStyle = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const lookupVar = opts.lookupVar ?? ((name: string) => rootStyle?.getPropertyValue(name) ?? '');
  const lookup = opts.lookup ?? ((id: string) => document.getElementById(id));
  const computedFont = typeof getComputedStyle === 'function' ? getComputedStyle(svg).fontFamily : '';
  const font = opts.font ?? (resolveVars(computedFont || '', lookupVar) || FALLBACK_FONT);

  const drawing = cleanClone(svg, lookupVar);
  const [, , vbW, vbH] = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const chartW = vbW || Number(svg.getAttribute('width')) || 400;
  const chartH = vbH || Number(svg.getAttribute('height')) || 600;
  const width = chartW + 2 * PAD;

  const captionH = PAD + CAPTION_SIZE + (info.subtitle ? SUB_SIZE + 8 : 0) + 8;
  const columns = info.legend.length > 3 ? 2 : 1;
  const rows = Math.ceil(info.legend.length / columns);
  const legendTop = captionH + chartH + 10;
  const legendH = rows ? rows * ROW_H + 8 : 0;
  const noteH = info.note ? 16 : 0;
  const height = legendTop + legendH + noteH + PAD;

  const root = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, 'font-family': font });
  const defs = el('defs', {});
  for (const d of inlinedDefs(drawing, lookup)) defs.appendChild(d);
  root.appendChild(defs);
  root.appendChild(el('rect', { width, height, fill: '#fff' }));

  root.appendChild(el('text', { x: PAD, y: PAD + CAPTION_SIZE - 2, 'font-size': CAPTION_SIZE, 'font-weight': 700, fill: INK }, info.caption));
  if (info.subtitle) {
    root.appendChild(el('text', { x: PAD, y: PAD + CAPTION_SIZE + SUB_SIZE + 4, 'font-size': SUB_SIZE, fill: MUTED }, info.subtitle));
  }

  drawing.setAttribute('x', String(PAD));
  drawing.setAttribute('y', String(captionH));
  drawing.setAttribute('width', String(chartW));
  drawing.setAttribute('height', String(chartH));
  if (info.axisUnit) {
    const { text, x, y } = info.axisUnit;
    drawing.appendChild(el('text', { x, y, 'font-size': 10, 'text-anchor': 'end', fill: MUTED }, text));
  }
  root.appendChild(drawing);

  const colW = (width - 2 * PAD) / columns;
  info.legend.forEach((item, i) => {
    const x = PAD + Math.floor(i / rows) * colW;
    const y = legendTop + (i % rows) * ROW_H;
    // A swatch of its own: the tile starts at its corner, as in the legend on screen.
    const swatch = el('svg', { x, y, width: SWATCH_W, height: SWATCH_H });
    if (item.underlay) swatch.appendChild(el('rect', { width: SWATCH_W, height: SWATCH_H, fill: '#fff' }));
    swatch.appendChild(el('rect', { x: 0.5, y: 0.5, width: SWATCH_W - 1, height: SWATCH_H - 1, fill: item.fill, stroke: SWATCH_BORDER }));
    root.appendChild(swatch);
    const codeX = x + SWATCH_W + 6;
    const code = el('text', { x: codeX, y: y + 12, 'font-size': 11, fill: INK });
    const codeSpan = el('tspan', { 'font-weight': 700 }, item.code);
    code.appendChild(codeSpan);
    const nameRoom = colW - SWATCH_W - 6 - (item.code.length + 1) * 11 * 0.62 - 8;
    code.appendChild(el('tspan', { fill: MUTED }, ` ${fitText(item.name, nameRoom, 11)}`));
    root.appendChild(code);
  });
  if (info.note) {
    root.appendChild(el('text', { x: width - PAD, y: legendTop + legendH + 10, 'font-size': 10, 'font-style': 'italic', 'text-anchor': 'end', fill: MUTED }, info.note));
  }

  return { svg: root as SVGSVGElement, width, height };
}

/**
 * The export as a PNG: the SVG drawn at `scale` × its size (vector rendering, not an upscaled bitmap)
 * on a white canvas.
 */
export async function svgToPng(chart: ChartSvg, scale = PNG_SCALE): Promise<Blob> {
  const w = Math.round(chart.width * scale);
  const h = Math.round(chart.height * scale);
  // The SVG's own size is the target size, so the browser rasterises it there.
  const sized = chartMarkup(chart, scale);
  const img = new Image();
  img.decoding = 'async';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('The chart could not be drawn as an image.'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  });
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw images.');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The chart could not be saved as PNG.'))), 'image/png'),
  );
}

/** The export as an SVG file. */
export const svgBlob = (chart: ChartSvg) => new Blob([chartMarkup(chart)], { type: 'image/svg+xml;charset=utf-8' });

/** True when the page may put an image on the clipboard (Clipboard API with ClipboardItem, secure origin). */
export function canCopyImage(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';
}

/**
 * Puts a PNG on the clipboard. The promise goes into the ClipboardItem as it is (not awaited first),
 * so Safari keeps the click's user activation while the image is drawn.
 */
export function copyPng(png: Promise<Blob>): Promise<void> {
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
