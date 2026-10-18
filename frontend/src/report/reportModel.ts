/**
 * Pure view model of the selection report (/report): one printable report for any selection of
 * boreholes, filled from the records only. A selection is a planned line's hits (by chainage), an area
 * drawn on the map, or a result set (a search, the filters, the LIST). What the source doesn't state
 * reads "not in source", never a made-up value; values a reviewer hasn't approved yet are marked `*`,
 * low-confidence and flagged ones `?`. Labels come in the report's language (EN | DE).
 */
import { certaintyOf } from '../domain/certainty';
import { decimal, unplottedText } from '../domain/format';
import { K } from '../domain/keys';
import { progress } from '../domain/review';
import { displayStatus } from '../domain/status';
import type { Alignment, AlignmentResult, AlignmentSide, Area, Borehole, BoreholeFilter, BoreholeStatus, ExtractedValue, ResultSet } from '../domain/types';
import { chainageText, lengthText, offsetText, SIDE_LABEL } from '../screens/map/alignment/alignmentModel';
import { cellOf, coordinatesCell, elevationCell, sheetModel, sheetT, type SheetCell, type SheetLang, type SheetModel } from '../screens/sheet/sheetModel';
import { statusChip } from '../theme';

/** What the report is about. */
export type ReportSelection =
  /** A planned line: its hits in chainage order. */
  | { kind: 'line'; resultSet: ResultSet | null; alignment: Alignment; result: AlignmentResult }
  /** An area drawn with the map tools (rectangle, polygon, circle). */
  | { kind: 'area'; resultSet: ResultSet; area: Area }
  /** Any other result set: a search, the filters, the LIST. */
  | { kind: 'set'; resultSet: ResultSet };

/** A report cell: a sheet cell, plus `unsure` for a low-confidence or flagged value. */
export interface ReportCell extends SheetCell { unsure: boolean }

/** Where a value or a borehole was read: file and page. */
export interface SourceRef { file: string; page: number | null }

export interface SummaryRow {
  /** 1-based number in the report (also the label on the map extract). */
  no: number;
  uid: string;
  id: string;
  name: ReportCell;
  /** WGS84 position, or why the borehole has none. */
  wgs84: { text: string; missing: boolean };
  /** Coordinates as printed with their system. */
  printed: ReportCell;
  groundLevel: ReportCell;
  finalDepth: ReportCell;
  status: BoreholeStatus;
  statusLabel: string;
  source: SourceRef;
  /** Planned line only. */
  line?: { chainage: string; offset: string; side: string };
}

export interface ReportLayer {
  n: number;
  range: string;
  description: ReportCell;
  din: string;
  strat: ReportCell;
}

/** One borehole of the per-borehole section: the sheet's header, its layers with stratigraphy. */
export interface ReportBorehole {
  no: number;
  uid: string;
  id: string;
  sheet: SheetModel;
  header: { label: string; cell: ReportCell }[];
  layers: ReportLayer[];
  source: SourceRef;
  /** "12 of 30 values reviewed". */
  review: string;
}

/** A line of the selection block: a label and its text. */
export interface SelectionFact { label: string; text: string }

export interface ReportModel {
  title: string;
  /** The selection in a few words, e.g. "Planned line: Trasse Nord". */
  subtitle: string;
  date: string;
  facts: SelectionFact[];
  summary: SummaryRow[];
  boreholes: ReportBorehole[];
  /** Selection members whose record could not be loaded (left out of the report). */
  missing: number;
  hasLine: boolean;
  footer: string;
}

const valueOf = (b: Borehole, key: string) => b.values.find((v) => v.key === key);

/** True when a value is uncertain enough to say so: low confidence, guessed, linted or flagged. */
export function isUnsure(v: ExtractedValue | undefined): boolean {
  if (!v || !v.hasProvenance || v.state !== 'ok') return false;
  const kind = certaintyOf(v).kind;
  return kind === 'unsure' || kind === 'flagged';
}

/** A sheet cell with the uncertainty of the value it shows. */
function withCertainty(b: Borehole, c: SheetCell): ReportCell {
  return { ...c, unsure: c.key ? isUnsure(valueOf(b, c.key)) : false };
}

/** A value of the record as a report cell (`fallback` when the record has no such value). */
function valueCell(lang: SheetLang, b: Borehole, key: string, fallback?: string | null): ReportCell {
  return withCertainty(b, cellOf(lang, valueOf(b, key), fallback));
}

/** "48.47123° N, 7.94612° E" (5 decimals, about a metre). */
export function wgs84Text(lat: number, lng: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(5)}° ${ns}, ${Math.abs(lng).toFixed(5)}° ${ew}`;
}

/** The number of a ground level value ("241.35" → 241.35), or null when the source states none. */
export function groundLevel(b: Borehole): number | null {
  const v = valueOf(b, K.elevation);
  if (!v || v.state !== 'ok' || !v.value.trim()) return null;
  const n = Number(v.value.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** The datum of the ground level ("NN", "NHN"), or null when the source states none. */
export function elevationDatum(b: Borehole): string | null {
  const v = valueOf(b, K.elevationDatum);
  return v && v.state === 'ok' && v.value.trim() ? v.value.trim() : b.meta.elevationDatum;
}

/** File and first page of a borehole. */
export function sourceOf(b: Borehole): SourceRef {
  return { file: b.sourceFile, page: b.primaryPage ?? b.pages[0] ?? null };
}

/** "report.pdf · p. 3" (or the file alone). */
export function sourceText(lang: SheetLang, s: SourceRef): string {
  const file = s.file || sheetT(lang, 'an upload');
  return s.page != null ? `${file} · ${sheetT(lang, 'p.')} ${s.page}` : file;
}

/** Natural order of borehole IDs ("BK-2" before "BK-10"), then uid for equal IDs. */
export function byId(a: Pick<Borehole, 'id' | 'uid'>, b: Pick<Borehole, 'id' | 'uid'>): number {
  return a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' }) || a.uid.localeCompare(b.uid);
}

/**
 * The records in report order: a line's by chainage (as the hits), others by ID. Members without a
 * loaded record are left out (the report says how many).
 */
export function orderedRecords(selection: ReportSelection, records: readonly Borehole[]): Borehole[] {
  const byUid = new Map(records.map((b) => [b.uid, b]));
  if (selection.kind === 'line') {
    const out: Borehole[] = [];
    for (const h of selection.result.hits) {
      const b = byUid.get(h.uid);
      if (b) out.push(b);
    }
    return out;
  }
  return [...records].sort(byId);
}

/** The member uids of a selection, in the order the report lists them once loaded. */
export function selectionUids(selection: ReportSelection): string[] {
  if (selection.kind === 'line') return selection.result.hits.map((h) => h.uid);
  return selection.resultSet.uids;
}

/* ---------- area size ---------- */

const EARTH_R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Area of a ring of [lng, lat] on the sphere in m² (spherical excess, good to well under 1 % at site scale). */
export function ringAreaM2(ring: readonly (readonly number[])[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[(i + 1) % ring.length];
    sum += rad(lng2 - lng1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return Math.abs((sum * EARTH_R * EARTH_R) / 2);
}

/** Area of a drawn shape in m². */
export function areaM2(a: Area): number {
  if (a.type === 'circle') return Math.PI * a.radiusM * a.radiusM;
  if (a.type === 'bbox') {
    const [w, s, e, n] = a.bbox;
    return ringAreaM2([
      [w, s],
      [e, s],
      [e, n],
      [w, n],
    ]);
  }
  const [outer, ...holes] = a.polygon.coordinates;
  return Math.max(0, ringAreaM2(outer) - holes.reduce((sum, h) => sum + ringAreaM2(h), 0));
}

/** "0.42 km²" from 0.1 km² up, "8,400 m²" below, with the report language's separators. */
export function areaText(m2: number, lang: SheetLang = 'en'): string {
  const locale = lang === 'de' ? 'de-DE' : 'en-US';
  if (m2 >= 100_000) return `${(m2 / 1_000_000).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km²`;
  return `${Math.round(m2).toLocaleString(locale)} m²`;
}

const SHAPE_LABEL: Record<Area['type'], string> = { bbox: 'Rectangle', polygon: 'Polygon', circle: 'Circle' };

/* ---------- selection facts ---------- */

/** True when a result set's definition filters nothing (every borehole, unreviewed included). */
function filtersNothing(f: BoreholeFilter): boolean {
  return (
    !f.search &&
    !f.country &&
    !f.project &&
    !f.documentId &&
    f.minDepth == null &&
    f.maxDepth == null &&
    !f.dinCodes.length &&
    f.lithologyMinDepth == null &&
    f.hasSpt == null &&
    f.hasGroundwater == null &&
    !f.reviewStatus.length &&
    f.includeUnreviewed &&
    !f.area
  );
}

/** The filters of a result set in words: "Search "BK-1" · DIN S, G · 5–20 m". */
export function filterText(lang: SheetLang, f: BoreholeFilter): string {
  const t = (en: string) => sheetT(lang, en);
  const parts: string[] = [];
  if (f.search) parts.push(`${t('Search')} “${f.search}”`);
  if (f.project) parts.push(`${t('Project')} ${f.project}`);
  if (f.country) parts.push(`${t('Country')} ${f.country}`);
  if (f.dinCodes.length) parts.push(`DIN ${f.dinCodes.join(', ')}`);
  if (f.minDepth != null || f.maxDepth != null) parts.push(`${t('Final depth')} ${f.minDepth ?? 0}–${f.maxDepth ?? '…'} m`);
  if (f.hasSpt) parts.push(t('with SPT'));
  if (f.hasGroundwater) parts.push(t('with groundwater'));
  if (f.reviewStatus.length) parts.push(f.reviewStatus.map((s) => t(statusChip(s).label)).join(', '));
  if (!f.includeUnreviewed) parts.push(t('reviewed only'));
  return parts.join(' · ');
}

/** The title line and the facts block of a selection. */
export function selectionFacts(lang: SheetLang, selection: ReportSelection, count: number): { subtitle: string; facts: SelectionFact[] } {
  const t = (en: string) => sheetT(lang, en);
  const n = (k: number) => `${k} ${t(k === 1 ? 'borehole' : 'boreholes')}`;
  if (selection.kind === 'line') {
    const { alignment: a, result: r } = selection;
    const facts: SelectionFact[] = [
      { label: t('Planned line'), text: a.name },
      { label: t('Length'), text: lengthText(r.lengthM || a.lengthM) },
      { label: t('Distance either side'), text: `${decimal(r.bufferM, r.bufferM % 1 ? 1 : 0)} m` },
      { label: t('Boreholes along the line'), text: n(count) },
      { label: t('Review scope'), text: r.includeUnreviewed ? t('unreviewed included') : t('reviewed only') },
      { label: t('Source'), text: `${a.fileName} · ${a.sourceCrs}` },
    ];
    if (r.excludedUnreviewed > 0) facts.push({ label: t('Not included'), text: `${n(r.excludedUnreviewed)} ${t('unreviewed inside the band')}` });
    if (r.notOnMap > 0) facts.push({ label: t('Not checked'), text: `${n(r.notOnMap)} ${t('without a map position')}` });
    return { subtitle: `${t('Planned line')}: ${a.name}`, facts };
  }
  const rs = selection.resultSet;
  const counts: SelectionFact[] = [
    { label: t('Boreholes'), text: n(count) },
    { label: t('On the map'), text: `${rs.locatedCount} · ${t('not on the map')} ${rs.unlocatedCount}` },
  ];
  if (selection.kind === 'area') {
    const shape = t(SHAPE_LABEL[selection.area.type]);
    const size = areaText(areaM2(selection.area), lang);
    const extra = selection.area.type === 'circle' ? ` · ${t('radius')} ${Math.round(selection.area.radiusM)} m` : '';
    const filters = filterText(lang, { ...rs.definition, area: null });
    const facts = [{ label: t('Area'), text: `${shape} · ${size}${extra}` }, ...counts];
    if (filters) facts.push({ label: t('Filters'), text: filters });
    return { subtitle: `${t('Area')}: ${shape}, ${size}`, facts };
  }
  const filters = filterText(lang, rs.definition);
  const all = filtersNothing(rs.definition);
  const facts = [...counts];
  if (filters) facts.unshift({ label: t('Filters'), text: filters });
  return { subtitle: all ? t('All boreholes') : `${t('Selection')}: ${filters}`, facts };
}

/* ---------- rows ---------- */

/** The summary table row of a borehole. */
export function summaryRow(lang: SheetLang, b: Borehole, no: number, hit?: { chainageM: number; offsetM: number; side: AlignmentSide }): SummaryRow {
  const t = (en: string) => sheetT(lang, en);
  const status = displayStatus(b);
  const row: SummaryRow = {
    no,
    uid: b.uid,
    id: b.id,
    name: valueCell(lang, b, K.boreholeName),
    wgs84: b.lat != null && b.lng != null ? { text: wgs84Text(b.lat, b.lng), missing: false } : { text: `${t('not on the map')}: ${t(unplottedText(b)).toLowerCase()}`, missing: true },
    printed: withCertainty(b, coordinatesCell(lang, b)),
    groundLevel: withCertainty(b, elevationCell(lang, b)),
    finalDepth: valueCell(lang, b, K.finalDepth),
    status,
    statusLabel: t(statusChip(status).label),
    source: sourceOf(b),
  };
  if (hit) row.line = { chainage: chainageText(hit.chainageM), offset: offsetText(hit.offsetM), side: t(SIDE_LABEL[hit.side]) };
  return row;
}

/** The per-borehole block: the sheet's header and layers, with stratigraphy and uncertainty. */
export function reportBorehole(lang: SheetLang, b: Borehole, no: number, today: Date): ReportBorehole {
  const t = (en: string) => sheetT(lang, en);
  const sheet = sheetModel(b, lang, { today });
  const layers: ReportLayer[] = sheet.layers.map((l) => {
    const layer = b.layers.find((x) => x.n === l.n);
    const stratValue = valueOf(b, K.strat(l.n));
    const strat: SheetCell =
      stratValue || !layer?.stratigraphicName ? cellOf(lang, stratValue) : { text: layer.stratigraphicName, missing: false, unreviewed: false };
    return { n: l.n, range: l.range, description: withCertainty(b, l.description), din: l.din, strat: withCertainty(b, strat) };
  });
  const p = progress(b);
  return {
    no,
    uid: b.uid,
    id: b.id,
    sheet,
    header: [
      ...sheet.header.map((h) => ({ label: h.label, cell: withCertainty(b, h.cell) })),
      { label: t('Name'), cell: valueCell(lang, b, K.boreholeName) },
    ],
    layers,
    source: sourceOf(b),
    review: p.total === 0 ? t('no reviewable values') : lang === 'de' ? `${p.approved} von ${p.total} Werten geprüft` : `${p.approved} of ${p.total} values reviewed`,
  };
}

/** The whole report of a selection: records in report order (see orderedRecords). */
export function reportModel(
  lang: SheetLang,
  selection: ReportSelection,
  records: readonly Borehole[],
  opts: { today: Date; missing?: number },
): ReportModel {
  const t = (en: string) => sheetT(lang, en);
  const hits = selection.kind === 'line' ? new Map(selection.result.hits.map((h) => [h.uid, h])) : null;
  const { subtitle, facts } = selectionFacts(lang, selection, records.length);
  const date = opts.today.toISOString().slice(0, 10);
  return {
    title: t('BOREHOLE REPORT'),
    subtitle,
    date,
    facts,
    summary: records.map((b, i) => summaryRow(lang, b, i + 1, hits?.get(b.uid))),
    boreholes: records.map((b, i) => reportBorehole(lang, b, i + 1, opts.today)),
    missing: opts.missing ?? 0,
    hasLine: selection.kind === 'line',
    footer: lang === 'de' ? `Erstellt von Bormisu am ${date} aus den hochgeladenen Berichten` : `Generated by Bormisu on ${date} from the uploaded reports`,
  };
}

