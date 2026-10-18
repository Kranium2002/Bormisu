/**
 * Pure view model of the generated borehole sheet (/sheet/:uid): what the A4 page shows, filled from
 * the record only. Labels come in the sheet's own language (EN | DE, independent of the app's UI
 * language); values stay as the record holds them, and what the source doesn't state reads "not in
 * source", never a made-up value. Values a reviewer hasn't approved yet are marked.
 */
import { decimal } from '../../domain/format';
import { K } from '../../domain/keys';
import { progress } from '../../domain/review';
import { formatSpt } from '../../domain/spt';
import type { Borehole, DocumentPage, ExtractedValue } from '../../domain/types';
import { translate } from '../../i18n';
import { sheet as SHEET_DE } from '../../i18n/de/sheet';
import { crsChip, depthOriginText, DEPTH_ORIGIN_LABEL, GW_LABEL, testTable, type TestRow } from '../detail/detailModel';

export type SheetLang = 'en' | 'de';

/** The sheet's language from ?lang=: German only when asked for, English otherwise. */
export const sheetLang = (param: string | null | undefined): SheetLang => (param === 'de' ? 'de' : 'en');

/** A sheet label in the sheet's language: the sheet's German texts first, then the app's. */
export function sheetT(lang: SheetLang, en: string): string {
  if (lang === 'en') return en;
  return SHEET_DE[en] ?? translate('de', en);
}

/**
 * One cell of the sheet: its text, grey italics when the source doesn't state it, `*` when not
 * reviewed yet. `key` is the record value the cell shows (keys.ts), when the record has one: the
 * screen shows that value in the original page.
 */
export interface SheetCell { text: string; missing: boolean; unreviewed: boolean; key?: string }

export interface HeaderField { label: string; cell: SheetCell }

export interface SheetLayer {
  n: number;
  range: string;
  description: SheetCell;
  din: string;
  consistency: string;
  spt: SheetCell;
  tcr: SheetCell;
  rqd: SheetCell;
}

export interface SheetModel {
  id: string;
  title: string;
  header: HeaderField[];
  /** The description column's heading, with "as printed" in German when the log isn't German. */
  descriptionHead: string;
  layers: SheetLayer[];
  /** TCR / RQD columns only when a layer has one of them. */
  hasCore: boolean;
  groundwater: { type: string; depth: SheetCell; date: string }[];
  samples: { name: string; type: string; depth: string }[];
  tests: { columns: string[]; rows: TestRow[] };
  review: { approved: number; total: number; text: string };
  footer: string;
  /** The depth origin note under the profile, e.g. "depth in m bgl". */
  depthNote: string;
}

const DASH = '–';
const valueOf = (b: Borehole, key: string) => b.values.find((v) => v.key === key);
const unreviewed = (v: ExtractedValue | undefined) => !!v && v.hasProvenance && v.status !== 'approved';

/** A value as a sheet cell: value and unit, or its state in the sheet's language; keyed by the value. */
export function cellOf(lang: SheetLang, v: ExtractedValue | undefined, fallback?: string | null): SheetCell {
  const t = (en: string) => sheetT(lang, en);
  if (!v) return fallback ? { text: fallback, missing: false, unreviewed: false } : { text: t('not in source'), missing: true, unreviewed: false };
  if (v.state !== 'ok') return { text: t(v.state), missing: true, unreviewed: unreviewed(v), key: v.key };
  if (!v.value.trim()) return { text: t('not in source'), missing: true, unreviewed: unreviewed(v), key: v.key };
  return { text: v.unit ? `${v.value} ${v.unit}` : v.value, missing: false, unreviewed: unreviewed(v), key: v.key };
}

/** "2025-03-11 – 2025-03-12", one date, or the drilling date; null when the source states none. */
function datesCell(lang: SheetLang, b: Borehole): SheetCell {
  const start = valueOf(b, K.startDate);
  const end = valueOf(b, K.endDate);
  const ok = (v: ExtractedValue | undefined) => !!v && v.state === 'ok' && !!v.value.trim();
  if (ok(start) && ok(end) && start!.value !== end!.value) {
    return { text: `${start!.value} – ${end!.value}`, missing: false, unreviewed: unreviewed(start) || unreviewed(end), key: start!.key };
  }
  if (ok(start)) return cellOf(lang, start);
  if (ok(end)) return cellOf(lang, end);
  return cellOf(lang, valueOf(b, K.drillingDate));
}

/** Coordinates with their CRS: "530039.85 / 5562120.29 · ETRS89 / UTM 32N (stated)". */
export function coordinatesCell(lang: SheetLang, b: Borehole): SheetCell {
  const xy = cellOf(lang, valueOf(b, K.xy));
  const crs = valueOf(b, K.crs);
  const name = crs && crs.state === 'ok' && crs.value ? crs.value : (b.crs.label ?? b.crs.code);
  if (xy.missing || !name) return xy;
  const status = sheetT(lang, crsChip(b).label.toLowerCase());
  return { ...xy, text: `${xy.text} · ${name} (${status})`, unreviewed: xy.unreviewed || unreviewed(crs) };
}

/** Surface elevation with its datum ("241.35 m · NHN"); a unit that already names the datum isn't repeated. */
export function elevationCell(lang: SheetLang, b: Borehole): SheetCell {
  const v = valueOf(b, K.elevation);
  const c = cellOf(lang, v);
  const dv = valueOf(b, K.elevationDatum);
  const datum = dv && dv.state === 'ok' && dv.value.trim() ? dv.value.trim() : b.meta.elevationDatum;
  if (c.missing) return c;
  if (!datum) return { ...c, text: `${c.text} · ${sheetT(lang, 'datum not stated')}` };
  return v?.unit.trim().endsWith(datum) ? c : { ...c, text: `${c.text} · ${datum}` };
}

/**
 * Whether the log's descriptions are German: the layer's description language when the record has
 * it, else the language of the borehole's first page, else unknown (null).
 */
export function descriptionLanguage(b: Borehole, pages: readonly Pick<DocumentPage, 'n' | 'language'>[]): string | null {
  const stated = b.values.find((v) => v.field === 'description_language' && v.value.trim());
  if (stated) return stated.value.trim().toLowerCase();
  return pages.find((p) => p.n === b.primaryPage)?.language?.toLowerCase() ?? null;
}

const isGerman = (lang: string | null) => !!lang && (lang === 'de' || lang.startsWith('de-') || lang === 'deu' || lang === 'ger' || lang === 'german');

/** The sheet of a borehole in a language, generated on `today` from the record. */
export function sheetModel(b: Borehole, lang: SheetLang, opts: { pages?: readonly Pick<DocumentPage, 'n' | 'language'>[]; today: Date }): SheetModel {
  const t = (en: string) => sheetT(lang, en);
  const german = isGerman(descriptionLanguage(b, opts.pages ?? []));
  const origin = b.meta.depthOrigin ? DEPTH_ORIGIN_LABEL[b.meta.depthOrigin] : null;
  const rock = valueOf(b, K.rockHead);
  const header: HeaderField[] = [
    { label: t('Project'), cell: cellOf(lang, valueOf(b, K.project), b.project || null) },
    { label: t('Borehole ID'), cell: cellOf(lang, valueOf(b, K.boreholeId), b.id) },
    { label: t('Location'), cell: cellOf(lang, valueOf(b, K.locationName)) },
    { label: t('Client'), cell: cellOf(lang, valueOf(b, K.client)) },
    { label: t('Contractor'), cell: cellOf(lang, valueOf(b, K.contractor)) },
    { label: t('Drilling method'), cell: cellOf(lang, valueOf(b, K.method)) },
    { label: t('Dates'), cell: datesCell(lang, b) },
    { label: t('Coordinates'), cell: coordinatesCell(lang, b) },
    { label: t('Surface elevation'), cell: elevationCell(lang, b) },
    { label: t('Final depth'), cell: cellOf(lang, valueOf(b, K.finalDepth)) },
    { label: t('Rock head'), cell: rock ? cellOf(lang, rock) : { text: t('not in source'), missing: true, unreviewed: false } },
  ];
  if (origin) header.push({ label: t('Depth origin'), cell: { text: t(origin), missing: false, unreviewed: false } });

  const layers: SheetLayer[] = b.layers.map((l) => {
    const lith = valueOf(b, K.lithology(l.n));
    const english = lith && lith.state === 'ok' && lith.value ? lith.value : l.lithology;
    const printed = lith?.raw || l.lithologyAsPrinted;
    // DE shows the log's own words; without them the English text, said so.
    const text = lang === 'de' ? printed || (english ? `${english} (${t('English')})` : '') : english;
    const sptValue = valueOf(b, K.spt(l.n));
    const spt = l.spt ?? sptValue?.spt;
    const sptText = sptValue && sptValue.state !== 'ok' ? t(sptValue.state) : spt ? (spt.refusal ? `R ${spt.raw}` : formatSpt(spt)) : DASH;
    const num = (key: string): SheetCell => {
      const v = valueOf(b, key);
      return v && v.state === 'ok' && v.value ? { text: v.value, missing: false, unreviewed: unreviewed(v), key } : { text: DASH, missing: false, unreviewed: false };
    };
    return {
      n: l.n,
      range: `${decimal(l.from)}–${decimal(l.to)}`,
      description: text
        ? { text, missing: false, unreviewed: unreviewed(lith), ...(lith ? { key: lith.key } : {}) }
        : { text: t('not in source'), missing: true, unreviewed: false },
      din: l.dinNotation || l.din || DASH,
      consistency: [l.consistency, l.weathering].filter(Boolean).join(', ') || DASH,
      spt: { text: sptText, missing: false, unreviewed: unreviewed(sptValue), ...(sptValue ? { key: sptValue.key } : {}) },
      tcr: num(K.tcr(l.n)),
      rqd: num(K.rqd(l.n)),
    };
  });

  const p = progress(b);
  const reviewText =
    p.total === 0
      ? t('no reviewable values')
      : lang === 'de'
        ? `${p.approved} von ${p.total} Werten geprüft`
        : `${p.approved} of ${p.total} values reviewed`;
  const date = opts.today.toISOString().slice(0, 10);
  const file = b.sourceFile || t('an upload');
  return {
    id: b.id,
    title: t('BOREHOLE LOG'),
    header,
    descriptionHead: lang === 'de' && !german ? `${t('Description')} (${t('as printed')})` : t('Description'),
    layers,
    hasCore: layers.some((l) => l.tcr.text !== DASH || l.rqd.text !== DASH),
    groundwater: b.groundwater.map((g) => {
      const v = valueOf(b, g.key);
      const depth = v ? cellOf(lang, v) : g.depth != null ? { text: `${decimal(g.depth)} m`, missing: false, unreviewed: false } : { text: t('depth not stated'), missing: true, unreviewed: false };
      return { type: t(GW_LABEL[g.type]), depth, date: g.date ?? DASH };
    }),
    samples: b.samples.map((s) => ({
      name: s.name || DASH,
      type: s.typeCode || DASH,
      depth: s.from == null && s.to == null ? t('not stated') : [s.from, s.to].filter((d) => d != null).map((d) => decimal(d!)).join('–'),
    })),
    tests: testTable(b),
    review: { approved: p.approved, total: p.total, text: reviewText },
    footer: lang === 'de' ? `Erstellt von Bormisu aus ${file} am ${date}` : `Generated by Bormisu from ${file} on ${date}`,
    depthNote: t(depthOriginText(b.meta)),
  };
}
