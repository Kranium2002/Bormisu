// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.
/**
 * Hand-made report "neckarbogen_BG_2019.pdf", borehole BK-07: the prototype's LAY, initRecs and
 * pageItems for the two log sheets (pages 7 and 8).
 */
import { decimalComma as cm } from '../domain/format';
import { K } from '../domain/keys';
import { formatSpt, sptLint } from '../domain/spt';
import type { Borehole, ExtractedValue, Layer, LayerProps, Method, PageItem, PatternId, Spt } from '../domain/types';
import { EXTRA_FIELDS, multiField } from '../schema/targetFormat';
import { Ln, sampleValue, T, textWidth } from './helpers';

export const NB_DOC_ID = 'nb';
export const NB_FILE = 'neckarbogen_BG_2019.pdf';
export const NB_PROJECT = 'Stadtbahn Neckarbogen';
/** The inferred CRS of the Neckarbogen report (not printed in the source). */
export const NB_CRS = { name: 'DHDN / GK zone 3', code: 'EPSG:31467' } as const;
/** The two log sheets of BK-07. */
export const BK07_PAGES = [7, 8] as const;
/** Fictional site office, about 110 m north-east of BK-07: where MY LOCATION's simulation puts you. */
export const NB_SITE = { label: 'Neckarbogen site', lat: 48.7912, lng: 9.1846 } as const;

interface LayRow {
  n: number; from: number; to: number; dr: string; raw: string[]; en: string; din: string;
  pat: PatternId; fill: string; st: string; m: Method; c: number;
  spt?: { raw: string; at: number } & ({ inc: number[]; n: number } | { refusal: true; blows: number; pen: number });
  rem?: string[];
  /** DIN 4023 extras, only where the printed description states them ("weich bis steif" picks none). */
  props?: LayerProps;
}

const LAY: LayRow[] = [
  { n: 1, from: 0, to: 0.4, dr: '0,40', raw: ['Mutterboden: Schluff,', 'humos, dunkelbraun'], en: 'Topsoil: silt, humic, dark brown', din: 'Mu', pat: 'topsoil', fill: '#E8D9C4', st: 'qh', m: 'Read', c: 0.96 },
  { n: 2, from: 0.4, to: 2.1, dr: '2,10', raw: ['Auffüllung: Schluff,', 'kiesig, Ziegelreste,', 'braun'], en: 'Fill: silt, gravelly, brick fragments, brown', din: 'A', pat: 'fill', fill: '#EFEFEF', st: 'y', m: 'OCR', c: 0.84, spt: { raw: '3,4,5 = 8', inc: [3, 4, 5], n: 8, at: 1.5 } },
  { n: 3, from: 2.1, to: 4.8, dr: '4,80', raw: ['Ton, schluffig, steif,', 'grau'], en: 'Clay, silty, stiff, grey', din: 'T, u', pat: 'clay', fill: '#DCD2EA', st: 'qh', m: 'Read', c: 0.95, spt: { raw: '4,5,5 = 10', inc: [4, 5, 5], n: 10, at: 3.5 }, rem: ['GW 3,10', 'RWS 2,40'], props: { consistencyDensity: 'steif' } },
  { n: 4, from: 4.8, to: 8.2, dr: '8,20', raw: ['Schluff, sandig, weich', 'bis steif, graubraun'], en: 'Silt, sandy, soft to stiff, grey-brown', din: 'U, s', pat: 'silt', fill: '#E1EAB8', st: 'qh', m: 'OCR', c: 0.81, spt: { raw: '2,3,4 = 7', inc: [2, 3, 4], n: 7, at: 6 } },
  { n: 5, from: 8.2, to: 11.2, dr: '11,20', raw: ['Kies, sandig, dicht,', 'gerundet, grau'], en: 'Gravel, sandy, dense, rounded, grey', din: 'G, s', pat: 'gravel', fill: '#FFFACD', st: 'qp', m: 'Read', c: 0.93, spt: { raw: '50/30', refusal: true, blows: 50, pen: 30, at: 10.5 }, props: { consistencyDensity: 'dicht' } },
  { n: 6, from: 11.2, to: 14.5, dr: '14,50', raw: ['Sandstein, verwittert,', 'mürbe, rotbraun', '(Stubensandstein)'], en: 'Sandstone, weathered, friable, red-brown', din: 'Sst', pat: 'sst', fill: '#FFD08A', st: 'kmS', m: 'OCR', c: 0.79, rem: ['TCR 74', 'RQD 18'], props: { weathering: 'w2_3', jointing: 'highly_jointed', core: true } },
];

/** Page of a layer: layers 1–4 on sheet 1 (p.7), 5–6 on sheet 2 (p.8). */
const lp = (n: number) => (n <= 4 ? 7 : 8);
/** Top y (px) of a layer row on its sheet. */
const ly = (n: number) => 222 + (n <= 4 ? n - 1 : n - 5) * 64;

function toSpt(s: NonNullable<LayRow['spt']>): Spt {
  return 'refusal' in s
    ? { raw: s.raw, depth: s.at, refusal: true, blows: s.blows, penetrationCm: s.pen }
    : { raw: s.raw, depth: s.at, refusal: false, increments: s.inc, n: s.n };
}

/** BK-07's values in review order (prototype initRecs). */
function bk07Values(): ExtractedValue[] {
  const L: ExtractedValue[] = [];
  const add = (o: Parameters<typeof sampleValue>[0]) => L.push(sampleValue(o));
  const b = 'borehole' as const;
  add({ key: K.boreholeId, field: 'BoreholeID', group: b, label: 'Borehole ID', raw: 'BK 7', value: 'BK-07', page: 7, box: [126, 94, 38, 20], method: 'Read', confidence: 0.98 });
  add({ key: K.project, field: 'ProjectName', group: b, label: 'Project', raw: 'Stadtbahn Neckarbogen, Los 2', value: 'Stadtbahn Neckarbogen, Lot 2', page: 7, box: [126, 72, 210, 20], method: 'Read', confidence: 0.97 });
  add({ key: K.startDate, field: 'StartDate', group: b, label: 'Start date', raw: '12.03.2019', value: '2019-03-12', page: 7, box: [356, 94, 80, 20], method: 'Read', confidence: 0.95, note: 'read as DD.MM.YYYY (German form)' });
  add({ key: K.method, field: EXTRA_FIELDS.drillingMethod, group: b, label: 'Drilling method', raw: 'Rotationskernbohrung', value: 'Rotary core drilling', page: 7, box: null, method: 'Read', confidence: 0.91 });
  add({ key: K.finalDepth, field: 'BoreholeDepth', group: b, label: 'Final depth', raw: '18,00 m', value: '18.00', unit: 'm', page: 7, box: [376, 116, 60, 20], method: 'OCR', confidence: 0.82, lint: { severity: 'error', message: 'Log bottom 14.50 m ≠ final depth 18.00 m' } });
  add({ key: K.elevation, field: 'Surface Elevation', group: b, label: 'Surface elevation', raw: '241,35 m NN', value: '241.35', unit: 'm NN', page: 7, box: [126, 138, 88, 20], method: 'OCR', confidence: 0.86, note: 'datum stored as printed, unconfirmed' });
  add({ key: K.xy, field: multiField('X-Coordinate', 'Y-Coordinate'), group: b, label: 'X / Y', raw: 'R 3 513 420 · H 5 405 870', value: '3513420 / 5405870', page: 7, box: [96, 160, 243, 20], method: 'Read', confidence: 0.94 });
  add({ key: K.crs, field: 'CoordinateSystem', group: b, label: 'CRS', raw: 'not stated', value: NB_CRS.name, page: 7, box: [96, 160, 243, 20], method: 'Guessed', confidence: 0.71, kind: 'crs' });
  add({ key: K.rockHead, field: EXTRA_FIELDS.rockHead, group: b, label: 'Rock head', raw: 'Sandstein ab 11,20 m', value: '11.20', unit: 'm', page: 8, box: [106, 282, 250, 54], method: 'Derived', confidence: 0.9, formula: 'top of first rock layer (layer 6)' });
  add({ key: K.notes, field: 'Notes', group: b, label: 'Remarks', raw: '', value: '', page: 7, box: null, method: 'Read', state: 'not in source' });
  add({ key: K.gwStrike, field: 'Groundwaterlevel', group: 'groundwater', label: 'GW strike', raw: 'GW 3,10', value: '3.10', unit: 'm bgl', page: 7, box: [452, 346, 58, 20], method: 'Read', confidence: 0.96 });
  add({ key: K.gwRest, field: 'Groundwaterlevel', group: 'groundwater', label: 'GW rest level', raw: 'RWS 2,40', value: '2.40', unit: 'm bgl', page: 7, box: [452, 362, 66, 20], method: 'Read', confidence: 0.93 });
  for (const l of LAY) {
    const page = lp(l.n);
    const y = ly(l.n);
    const base = { group: 'layer' as const, layer: l.n, page };
    add({ ...base, key: K.bottom(l.n), field: EXTRA_FIELDS.depthTo, label: 'Bottom depth', raw: l.dr, value: l.to.toFixed(2), unit: 'm', box: [26, y - 4, 44, 20], method: l.m, confidence: l.c });
    add({ ...base, key: K.lithology(l.n), field: 'Lithology/SoilName', label: 'Lithology', raw: l.raw.join(' '), value: l.en, din: l.din, box: [106, y - 4, 250, l.raw.length * 16 + 6], method: l.m, confidence: l.c, kind: 'lithology' });
    if (l.spt) {
      const spt = toSpt(l.spt);
      const lint = sptLint(spt);
      add({
        ...base, key: K.spt(l.n), field: 'SPT', label: `SPT @ ${spt.depth.toFixed(2)} m`, raw: spt.raw, value: formatSpt(spt),
        box: [362, y - 4, textWidth(spt.raw), 20], method: 'Read', confidence: spt.refusal ? 0.9 : 0.92,
        kind: 'spt', refusal: spt.refusal, spt, ...(lint ? { lint } : {}),
      });
    }
    if (l.n === 6) {
      add({ ...base, key: K.tcr(6), field: 'TotalCoreRecovery', label: 'TCR', raw: 'TCR 74', value: '74', unit: '%', box: [452, 282, 52, 20], method: 'OCR', confidence: 0.83 });
      add({ ...base, key: K.rqd(6), field: 'RQD', label: 'RQD', raw: 'RQD 18', value: '18', unit: '%', box: [452, 298, 52, 20], method: 'Guessed', confidence: 0.58, note: '“18” partly covered by a stamp' });
    }
  }
  return L;
}

function bk07Layers(): Layer[] {
  return LAY.map((l) => ({
    n: l.n, from: l.from, to: l.to,
    lithology: l.en, lithologyAsPrinted: l.raw.join(' '), din: l.din,
    pattern: l.pat, fill: l.fill, strat: l.st, method: l.m, confidence: l.c,
    ...(l.spt ? { spt: toSpt(l.spt) } : {}),
    ...(l.n === 6 ? { tcr: 74, rqd: 18 } : {}),
    ...(l.props ? { props: l.props } : {}),
  }));
}

/** The BK-07 borehole at the given map position (prototype BK7 override: 48.7905, 9.1835). */
export function bk07(lat: number, lng: number): Borehole {
  const layers = bk07Layers();
  return {
    uid: `${NB_DOC_ID}:BK-07`,
    id: 'BK-07',
    documentId: NB_DOC_ID,
    sourceFile: NB_FILE,
    project: NB_PROJECT,
    lat,
    lng,
    onMap: true,
    unplottedReason: null,
    finalDepth: 18,
    logBottom: layers[layers.length - 1].to,
    crs: { ...NB_CRS, status: 'inferred' },
    layers,
    groundwater: [
      { type: 'strike', depth: 3.1, key: K.gwStrike },
      { type: 'rest', depth: 2.4, key: K.gwRest },
    ],
    rockHead: 11.2,
    values: bk07Values(),
    primaryPage: 7,
  };
}

/** Items of BK-07 log sheet 1 (page 7) or 2 (page 8). */
export function bk07Sheet(p: (typeof BK07_PAGES)[number]): PageItem[] {
  const it = [T(24, 22, 'SCHICHTENVERZEICHNIS', 16, 700), T(24, 44, p === 7 ? 'nach DIN 4022 · Anlage 3.7' : 'Anlage 3.7 (Forts.)', 11), T(430, 22, `Blatt ${p - 6} von 2`)];
  if (p === 7) {
    it.push(
      T(24, 76, 'Bauvorhaben:'), T(130, 76, 'Stadtbahn Neckarbogen, Los 2'), T(24, 98, 'Bohrung:'), T(130, 98, 'BK 7'),
      T(300, 98, 'Datum:'), T(360, 98, '12.03.2019'), T(24, 120, 'Verfahren:'), T(130, 120, 'Rotationskernbohrung'),
      T(300, 120, 'Endteufe:'), T(380, 120, `${cm(18)} m`), T(24, 142, 'Ansatzhöhe:'), T(130, 142, '241,35 m NN'),
      T(24, 164, 'Rechts:'), T(100, 164, '3 513 420'), T(220, 164, 'Hoch:'), T(270, 164, '5 405 870'),
      T(400, 740, 'Forts. Blatt 2', 11),
    );
  } else {
    it.push(T(24, 76, 'Bohrung:'), T(130, 76, 'BK 7'), T(110, 360, '— Ende der Aufzeichnung —'));
  }
  it.push(
    Ln(24, 188, 512, 1), Ln(24, 212, 512, 1), Ln(24, 760, 512, 1), Ln(24, 188, 1, 572), Ln(536, 188, 1, 573),
    Ln(100, 188, 1, 572), Ln(360, 188, 1, 572), Ln(448, 188, 1, 572),
    T(30, 194, 'bis m', 11, 700), T(110, 194, 'Benennung und Beschreibung', 11, 700), T(366, 194, 'SPT', 11, 700), T(456, 194, 'Bemerkung', 11, 700),
  );
  for (const l of LAY.filter((x) => lp(x.n) === p)) {
    const y = ly(l.n);
    it.push(T(30, y, l.dr));
    l.raw.forEach((s, k) => it.push(T(110, y + k * 16, s)));
    if (l.spt) it.push(T(366, y, l.spt.raw));
    (l.rem ?? []).forEach((s, k) => it.push(T(456, y + k * 16, s)));
    it.push(Ln(24, y + 54, 512, 1, '#9a9a9a'));
  }
  return it;
}
