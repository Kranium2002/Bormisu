// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.
/**
 * Deterministic generators for the fictional borehole archive (prototype PROJ, BHS, GEO, genBH,
 * genPage, hashS, mulberry32). The same borehole ID always yields the same borehole.
 */
import { decimalComma as cm } from '../domain/format';
import { K } from '../domain/keys';
import { formatSpt } from '../domain/spt';
import { deriveReviewStatus } from '../domain/status';
import type { Borehole, ExtractedValue, Layer, Method, PageItem, Sample, Spt, TestResult, UnplottedReason } from '../domain/types';
import { EXTRA_FIELDS, multiField } from '../schema/targetFormat';
import { Ln, sampleValue, T, textWidth, type SampleValueInput } from './helpers';
import { NB_CRS, NB_PROJECT } from './neckarbogen';

/* ---------- projects and seeds (prototype PROJ, BHS) ---------- */

/**
 * Per-borehole base code: r = reviewed, a = attention (one lint warning and an open question, see clarifications.ts),
 * u / x = unreviewed, N = no coordinates in source, C = CRS unknown (local site grid), M = named but
 * missing (skipped).
 */
export interface Project { name: string; pre: string; lat: number; lng: number; list: string; nb?: boolean }

export const PROJECTS: Project[] = [
  { name: NB_PROJECT, pre: 'BK-', lat: 48.795, lng: 9.2, list: 'rrruuuxuuuuMNN', nb: true },
  { name: 'Elbquerung Ost', pre: 'EQ-', lat: 53.535, lng: 10.02, list: 'rrrrrrrrr' },
  { name: 'Mainufer-Sammler', pre: 'MS-', lat: 50.105, lng: 8.69, list: 'rruraru' },
  { name: 'Emscher-Kanal Ost', pre: 'EM-', lat: 51.515, lng: 7.48, list: 'rrrarr' },
  { name: 'Spree-Kabeltunnel', pre: 'SK-', lat: 52.505, lng: 13.43, list: 'uuuuC' },
  { name: 'Rheinbogen-Fernwärme', pre: 'RB-', lat: 50.94, lng: 6.98, list: 'rrrr' },
  { name: 'City-Ring Leipzig', pre: 'CL-', lat: 51.34, lng: 12.38, list: 'ruua' },
];

export interface Seed {
  id: string; project: string; nb: boolean; lat: number; lng: number; depth: number;
  base: string; onMap: boolean; reason: UnplottedReason | null;
}

/** All borehole seeds in prototype order, with the BK-07 override. */
export function makeSeeds(): Seed[] {
  const out: Seed[] = [];
  PROJECTS.forEach((p, pi) =>
    [...p.list].forEach((t, i) => {
      if (t === 'M') return;
      const a = pi * 7 + i * 2.3;
      const r = 0.012 + (0.01 * ((i * 37) % 7)) / 7;
      out.push({
        id: p.pre + String(i + 1).padStart(2, '0'),
        project: p.name,
        nb: !!p.nb,
        lat: p.lat + Math.sin(a) * r,
        lng: p.lng + Math.cos(a) * r * 1.5,
        depth: Number((10 + ((i * 7 + pi * 3) % 17) + (i % 2 ? 0.5 : 0)).toFixed(2)),
        base: t,
        onMap: !(t === 'N' || t === 'C'),
        reason: t === 'N' ? 'no_coordinates' : t === 'C' ? 'crs_unknown' : null,
      });
    }),
  );
  const bk7 = out.find((b) => b.id === 'BK-07');
  if (bk7) Object.assign(bk7, { lat: 48.7905, lng: 9.1835, depth: 18 });
  return out;
}

/* ---------- geology per project (prototype GEO) ---------- */

/** Soil family of a unit: picks the SPT range and whether an SPT is drilled at all. */
type Family = 'topsoil' | 'fill' | 'clay' | 'silt' | 'sand' | 'gravel' | 'marl' | 'rock';

/**
 * One geological unit: English and printed (German) description, the main component as a key of
 * din_codes.json plus the full DIN short form, a plain-text stratigraphic name and age, thickness range.
 */
interface Unit {
  en: string; de: string; din: string; notation: string; family: Family;
  strat: string; age: string | null; th: number[]; rock: boolean;
}
const U = (en: string, de: string, din: string, notation: string, family: Family, strat: string, age: string | null, th: number[], rock = false): Unit =>
  ({ en, de, din, notation, family, strat, age, th, rock });

const FILL = U('Fill: sand, gravelly, rubble', 'Auffüllung: Sand, kiesig, Bauschutt', 'A', 'A', 'fill', 'Made ground', null, [0.8, 2.5]);
const TOP = U('Topsoil: silt, humic', 'Mutterboden: Schluff, humos', 'Mu', 'Mu', 'topsoil', 'Holocene topsoil', 'Quaternary', [0.2, 0.5]);
const SAND = U('Sand, fine to medium, medium dense', 'Sand, fein- bis mittelkörnig, mitteldicht', 'S', 'S', 'sand', 'Holocene sand', 'Quaternary', [2, 5]);
const GRAV = U('Gravel, sandy, dense', 'Kies, sandig, dicht', 'G', 'G, s', 'gravel', 'Pleistocene river gravel', 'Quaternary', [2, 4.5]);
const LOESS = U('Silt, fine sandy (loess), stiff', 'Schluff, feinsandig (Löss), steif', 'Lö', 'U, fs', 'silt', 'Weichselian loess', 'Quaternary', [2, 4]);
const TILL = U('Boulder clay, stiff, with stones', 'Geschiebemergel, steif, steinig', 'Mg', 'Mg', 'marl', 'Pleistocene till', 'Quaternary', [3, 6]);
const CLAY = U('Clay, silty, stiff, grey', 'Ton, schluffig, steif, grau', 'T', 'T, u', 'clay', 'Holocene floodplain clay', 'Quaternary', [2, 4]);

const GEO: Record<string, Unit[]> = {
  [NB_PROJECT]: [TOP, FILL, CLAY, GRAV, U('Sandstone, weathered, friable', 'Sandstein, verwittert, mürbe', 'Sst', 'Sst', 'rock', 'Stubensandstein (Middle Keuper)', 'Triassic', [0], true)],
  'Elbquerung Ost': [FILL, SAND, TILL, U('Clay, fat, dark grey (Lauenburg clay)', 'Ton, fett, dunkelgrau (Lauenburger Ton)', 'T', 'T', 'clay', 'Lauenburg clay', 'Quaternary', [0])],
  'Mainufer-Sammler': [
    FILL,
    { ...GRAV, en: 'Gravel, sandy (Main terrace)', de: 'Kies, sandig (Mainterrasse)', strat: 'Main terrace gravel' },
    U('Clay, calcareous, stiff (Frankfurt clay)', 'Ton, kalkig, steif (Frankfurter Ton)', 'T', 'T, k', 'clay', 'Frankfurt clay', 'Neogene', [3, 6]),
    U('Limestone, jointed', 'Kalkstein, klüftig', 'Kst', 'Kst', 'rock', 'Miocene limestone', 'Neogene', [0], true),
  ],
  'Emscher-Kanal Ost': [FILL, LOESS, SAND, U('Marlstone, slightly weathered', 'Mergelstein, angewittert', 'Mst', 'Mst', 'rock', 'Emscher marl', 'Cretaceous', [0], true)],
  'Spree-Kabeltunnel': [FILL, SAND, TILL, { ...SAND, th: [0] }],
  'Rheinbogen-Fernwärme': [FILL, SAND, { ...GRAV, en: 'Gravel, sandy, cobbly (Rhine terrace)', de: 'Kies, sandig, steinig (Rheinterrasse)', strat: 'Rhine lower terrace' }, { ...SAND, th: [0] }],
  'City-Ring Leipzig': [FILL, LOESS, GRAV, { ...CLAY, strat: 'Miocene clay', age: 'Neogene', th: [0] }],
};

/** Projects whose rock cores were sampled and tested in the lab (one UCS test per rock layer). */
const CORE_TESTED = new Set(['Mainufer-Sammler', 'Emscher-Kanal Ost']);

/* ---------- deterministic helpers ---------- */

/** String hash used to seed the RNG per borehole ID (prototype hashS). */
export const hashS = (s: string): number => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

/** mulberry32 PRNG (prototype `mul`): returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Groups thousands with spaces: 3513420 -> "3 513 420" (prototype fmtN). */
export const fmtN = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Wraps text into lines of at most n characters (prototype wrapT). */
export function wrapT(t: string, n: number): string[] {
  const lines: string[] = [];
  let c = '';
  t.split(' ').forEach((x) => {
    if (`${c} ${x}`.trim().length > n) {
      lines.push(c);
      c = x;
    } else c = `${c} ${x}`.trim();
  });
  if (c) lines.push(c);
  return lines;
}

/* ---------- generator (prototype genBH + genPage) ---------- */

interface GenLayer extends Unit {
  n: number; from: number; to: number; m: Method; c: number;
  y: number; lines: string[]; rem: string[];
  spt?: Spt; sptAt?: number; tcr?: number; rqd?: number;
}

/** Where a generated borehole lives: its document and page. */
export interface Placement { documentId: string; file: string; page: number }

/** A generated borehole plus the items of its log page. */
export interface Generated { borehole: Borehole; items: PageItem[] }

type Box4 = readonly [number, number, number, number];
type ValueDraft = Omit<SampleValueInput, 'page' | 'group'> & { group?: SampleValueInput['group'] };

/** Generates one fictional borehole and its log page, deterministically from the seed's ID. */
export function generateBorehole(seed: Seed, at: Placement): Generated {
  const rnd = mulberry32(hashS(seed.id));
  const R = (a: number, c: number) => a + (c - a) * rnd();
  const fd = seed.depth;
  const units = GEO[seed.project] ?? GEO['Spree-Kabeltunnel'];

  // layers
  const layers: GenLayer[] = [];
  let cur = 0;
  units.forEach((u, i) => {
    if (cur >= fd - 0.05) return;
    const last = i === units.length - 1 || u.rock || !u.th[0];
    let to = last ? fd : Math.round((cur + R(u.th[0], u.th[1])) * 10) / 10;
    if (to > fd - 1) to = fd;
    const m: Method = rnd() < 0.72 ? 'Read' : 'OCR';
    layers.push({ ...u, n: layers.length + 1, from: cur, to, m, c: 0.78 + rnd() * 0.2, y: 0, lines: [], rem: [] });
    cur = to;
  });

  // SPT, TCR, RQD
  layers.forEach((l) => {
    const h = l.to - l.from;
    if (l.rock) {
      l.tcr = Math.round(R(62, 98));
      l.rqd = Math.round(R(12, 80));
      return;
    }
    if (l.family === 'topsoil' || h < 0.8) return;
    const depth = Math.round((l.from + h / 2) * 2) / 2;
    l.sptAt = depth;
    if (l.family === 'gravel' && rnd() < 0.45) {
      const pen = 5 + Math.floor(rnd() * 5) * 5;
      l.spt = { raw: `50/${pen}`, depth, refusal: true, blows: 50, penetrationCm: pen };
      return;
    }
    const rg = ({ fill: [3, 9], clay: [6, 15], silt: [4, 11], sand: [10, 30], gravel: [24, 44], marl: [22, 40] } as Record<string, number[]>)[l.family] ?? [5, 15];
    const N = Math.round(R(rg[0], rg[1]));
    const b2 = Math.floor(N / 2);
    const inc = [Math.max(1, Math.round(N / 3)), b2, N - b2];
    l.spt = { raw: `${inc[0]},${inc[1]},${inc[2]} = ${N}`, depth, refusal: false, increments: inc, n: N };
  });

  // groundwater, date, method, elevation
  const gwS = Math.round(R(1.4, Math.min(6, fd - 2)) * 100) / 100;
  const gwR = Math.max(0.5, Math.round((gwS - R(0.3, 1)) * 100) / 100);
  const dd = 1 + Math.floor(rnd() * 27);
  const mm = 1 + Math.floor(rnd() * 12);
  const yy = 2008 + Math.floor(rnd() * 14);
  const core = rnd() < 0.6;
  const rockLayer = layers.find((l) => l.rock);
  const elev = R(32, 240).toFixed(2);
  // Drawn after every prototype value, so the prototype's numbers stay the same.
  const ucs = rockLayer && CORE_TESTED.has(seed.project) ? Math.round(R(4, 60) * 10) / 10 : null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateRaw = `${pad(dd)}.${pad(mm)}.${yy}`;
  const dateIso = `${yy}-${pad(mm)}-${pad(dd)}`;
  const methRaw = core ? 'Rotationskernbohrung' : 'Rammkernbohrung';
  const methEn = core ? 'Rotary core drilling' : 'Driven core sampling';

  // coordinates as printed
  let A: number;
  let B: number;
  let xLab: [string, string];
  if (seed.nb) {
    A = 3513420 + Math.round((seed.lng - 9.1835) * 73000);
    B = 5405870 + Math.round((seed.lat - 48.7905) * 111200);
    xLab = ['Rechts:', 'Hoch:'];
  } else {
    A = Math.round(500000 + (seed.lng - 9) * 111320 * Math.cos((seed.lat * Math.PI) / 180));
    B = Math.round(seed.lat * 110950);
    xLab = ['Ost:', 'Nord:'];
  }
  const hasCoords = seed.base !== 'N';
  const crs = crsOf(seed);

  // values in review order
  const page = at.page;
  const idRaw = seed.id.replace('-', ' ');
  const fdRaw = `${cm(fd)} m`;
  const elevRaw = `${cm(Number(elev))} m NN`;
  const xyBox: Box4 = [96, 160, 243, 20];
  const crsRaw = crs.status === 'stated' ? '(ETRS89 / UTM 32N)' : crs.status === 'unknown' ? '(Baustellennetz)' : '';
  const head: ValueDraft[] = [
    { key: K.boreholeId, field: 'BoreholeID', label: 'Borehole ID', raw: idRaw, value: seed.id, box: [126, 94, textWidth(idRaw), 20], method: 'Read', confidence: 0.97 },
    { key: K.project, field: 'ProjectName', label: 'Project', raw: seed.project, value: seed.project, box: [126, 72, textWidth(seed.project), 20], method: 'Read', confidence: 0.97 },
    { key: K.startDate, field: 'StartDate', label: 'Start date', raw: dateRaw, value: dateIso, box: [356, 94, 80, 20], method: 'Read', confidence: 0.95 },
    { key: K.method, field: EXTRA_FIELDS.drillingMethod, label: 'Drilling method', raw: methRaw, value: methEn, box: [126, 116, textWidth(methRaw), 20], method: 'Read', confidence: 0.92 },
    { key: K.finalDepth, field: 'BoreholeDepth', label: 'Final depth', raw: fdRaw, value: fd.toFixed(2), unit: 'm', box: [376, 116, textWidth(fdRaw), 20], method: 'OCR', confidence: 0.86 },
    { key: K.elevation, field: 'Surface Elevation', label: 'Surface elevation', raw: elevRaw, value: elev, unit: 'm', box: [126, 138, textWidth(elevRaw), 20], method: 'OCR', confidence: 0.84, note: 'datum: NN (as printed, unconfirmed)' },
    hasCoords
      ? { key: K.xy, field: multiField('X-Coordinate', 'Y-Coordinate'), label: 'X / Y', raw: `${fmtN(A)} · ${fmtN(B)}`, value: `${A} / ${B}`, box: xyBox, method: 'Read', confidence: 0.93 }
      : { key: K.xy, field: multiField('X-Coordinate', 'Y-Coordinate'), label: 'X / Y', raw: '', value: '', box: null, method: 'Read', state: 'not in source' },
    crs.status === 'inferred'
      ? { key: K.crs, field: 'CoordinateSystem', label: 'CRS', raw: 'not stated', value: NB_CRS.name, box: hasCoords ? xyBox : null, method: 'Guessed', confidence: 0.71, kind: 'crs' }
      : { key: K.crs, field: 'CoordinateSystem', label: 'CRS', raw: crsRaw, value: crs.name ?? 'local site grid (no EPSG code)', box: [396, 160, textWidth(crsRaw), 20], method: 'Read', confidence: 0.95, kind: 'crs' },
  ];
  const tail: ValueDraft[] = [];
  const layerVals: ValueDraft[] = [];
  const labVals: ValueDraft[] = [];
  const samples: Sample[] = [];
  const testResults: TestResult[] = [];
  let gw: { s: Box4 | null; r: Box4 | null } = { s: null, r: null };

  layers.forEach((l, i) => {
    const y = 222 + i * 64;
    l.y = y;
    l.lines = wrapT(l.de, 30).slice(0, 3);
    const lith: Box4 = [106, y - 4, 250, l.lines.length * 16 + 6];
    const lv = { group: 'layer' as const, layer: l.n, method: l.m, confidence: l.c };
    layerVals.push({ ...lv, key: K.bottom(l.n), field: EXTRA_FIELDS.depthTo, label: 'Bottom depth', raw: cm(l.to), value: l.to.toFixed(2), unit: 'm', box: [26, y - 4, 44, 20] });
    layerVals.push({ ...lv, key: K.lithology(l.n), field: 'Lithology/SoilName', label: `Layer ${l.n} lithology`, raw: l.de, value: l.en, din: l.din, box: lith, kind: 'lithology' });
    if (l.spt && l.sptAt != null) {
      layerVals.push({ ...lv, key: K.spt(l.n), field: 'SPT', label: `SPT @ ${l.sptAt.toFixed(2)} m`, raw: l.spt.raw, value: formatSpt(l.spt), box: [362, y - 4, Math.round(l.spt.raw.length * 6.6 + 8), 20], method: 'Read', confidence: 0.9, kind: 'spt', refusal: l.spt.refusal, spt: l.spt });
    }
    if (gwS >= l.from && gwS < l.to) {
      const k = l.rem.length;
      l.rem.push(`GW ${cm(gwS)}`, `RWS ${cm(gwR)}`);
      gw = { s: [462, y - 4 + k * 16, 58, 20], r: [462, y + 12 + k * 16, 66, 20] };
    }
    if (l.rock && l.tcr != null && l.rqd != null) {
      const k = l.rem.length;
      l.rem.push(`TCR ${l.tcr}`, `RQD ${l.rqd}`);
      layerVals.push({ ...lv, key: K.tcr(l.n), field: 'TotalCoreRecovery', label: 'TCR', raw: `TCR ${l.tcr}`, value: String(l.tcr), unit: '%', box: [462, y - 4 + k * 16, 52, 20] });
      layerVals.push({ ...lv, key: K.rqd(l.n), field: 'RQD', label: 'RQD', raw: `RQD ${l.rqd}`, value: String(l.rqd), unit: '%', box: [462, y + 12 + k * 16, 52, 20] });
      if (l === rockLayer) {
        tail.push({ key: K.rockHead, field: EXTRA_FIELDS.rockHead, label: 'Rock head', raw: `${l.de.split(',')[0]} ab ${cm(l.from)} m`, value: l.from.toFixed(2), unit: 'm', box: lith, method: 'Derived', confidence: 0.9, formula: `top of first rock layer (layer ${l.n})` });
      }
      if (l === rockLayer && ucs != null) {
        // One core sample from the middle of the rock layer, tested for UCS.
        const from = Math.round(((l.from + l.to) / 2) * 10) / 10;
        const name = 'KP 1';
        const j = l.rem.length;
        l.rem.push(`${name}: ${cm(from)} m`, `UCS ${cm(ucs, 1)} MPa`);
        const sBox: Box4 = [462, y - 4 + j * 16, 76, 20];
        const tBox: Box4 = [462, y + 12 + j * 16, 76, 20];
        labVals.push({ group: 'sample', index: 0, key: K.sampleName(0), field: 'SampleName', label: 'Sample', raw: name, value: name, box: sBox, method: 'Read', confidence: 0.94 });
        labVals.push({ group: 'sample', index: 0, key: K.sampleDepth(0), field: 'SampleDepth', label: `Sample ${name} depth`, raw: `${cm(from)} m`, value: from.toFixed(2), unit: 'm', box: sBox, method: 'Read', confidence: 0.94 });
        labVals.push({ group: 'test', index: 0, key: K.test(0), field: 'UCS', label: 'UCS', raw: `UCS ${cm(ucs, 1)} MPa`, value: String(ucs), unit: 'MPa', box: tBox, method: 'OCR', confidence: 0.88 });
        samples.push({ name, typeCode: 'core', from, to: Math.round((from + 0.3) * 10) / 10, key: K.sampleName(0) });
        testResults.push({ name: 'UCS', value: ucs, qualifier: null, unit: 'MPa', sampleName: name, depth: from, key: K.test(0) });
      }
    }
  });
  tail.push({ key: K.notes, field: 'Notes', label: 'Remarks', raw: '', value: '', box: null, method: 'Read', state: 'not in source' });
  const gwVals: ValueDraft[] = [
    { group: 'groundwater', key: K.gwStrike, field: 'Groundwaterlevel', label: 'GW strike', raw: `GW ${cm(gwS)}`, value: gwS.toFixed(2), unit: 'm bgl', box: gw.s, method: gw.s ? 'Read' : 'OCR', confidence: gw.s ? 0.95 : 0.7 },
    { group: 'groundwater', key: K.gwRest, field: 'Groundwaterlevel', label: 'GW rest level', raw: `RWS ${cm(gwR)}`, value: gwR.toFixed(2), unit: 'm bgl', box: gw.r, method: gw.r ? 'Read' : 'OCR', confidence: gw.r ? 0.92 : 0.7 },
  ];
  const values = applyBase(
    seed.base,
    [...head, ...tail, ...gwVals, ...layerVals, ...labVals].map((v) => sampleValue({ group: 'borehole', ...v, page })),
  );

  const borehole: Borehole = {
    uid: `${at.documentId}:${seed.id}`,
    id: seed.id,
    documentId: at.documentId,
    sourceFile: at.file,
    project: seed.project,
    revision: 1,
    reviewStatus: deriveReviewStatus(values),
    // Counted by the sample source from its questions (clarifications.ts): the report's coordinate
    // system (Neckarbogen) and one question each for the base "a" boreholes.
    openClarifications: 0,
    lat: seed.onMap ? seed.lat : null,
    lng: seed.onMap ? seed.lng : null,
    onMap: seed.onMap,
    unplottedReason: seed.reason,
    finalDepth: fd,
    logBottom: layers[layers.length - 1].to,
    crs,
    meta: {
      aliases: [idRaw],
      elevationDatum: 'NN',
      depthOrigin: 'ground',
      depthSource: 'printed',
      xRaw: hasCoords ? fmtN(A) : null,
      yRaw: hasCoords ? fmtN(B) : null,
      axisLabelsRaw: hasCoords ? xLab.map((x) => x.replace(':', '')).join(', ') : null,
      localX: hasCoords ? A : null,
      localY: hasCoords ? B : null,
    },
    layers: layers.map(toLayer),
    groundwater: [
      { type: 'strike', depth: gwS, elevation: null, date: null, raw: `GW ${cm(gwS)}`, key: K.gwStrike },
      { type: 'rest', depth: gwR, elevation: null, date: null, raw: `RWS ${cm(gwR)}`, key: K.gwRest },
    ],
    samples,
    testResults,
    rockHead: rockLayer ? rockLayer.from : null,
    values,
    pages: [page],
    primaryPage: page,
  };
  const printed = { project: seed.project, idRaw, dateRaw, methRaw, fdRaw, elevRaw, xLab, xA: fmtN(A), xB: fmtN(B), hasCoords, crsRaw };
  return { borehole, items: genPage(page, printed, layers) };
}

/** CRS of a seed: Neckarbogen inferred, local-grid boreholes unknown, all others stated. */
function crsOf(seed: Seed): Borehole['crs'] {
  if (seed.nb) return { ...NB_CRS, status: 'inferred' };
  if (seed.base === 'C') return { name: null, code: null, status: 'unknown' };
  return { name: 'ETRS89 / UTM zone 32N', code: 'EPSG:25832', status: 'stated' };
}

/** Review state per base code: r = all approved, a = one open lint warning, others unreviewed. */
function applyBase(base: string, values: ExtractedValue[]): ExtractedValue[] {
  if (base === 'r') return values.map((v) => ({ ...v, status: 'approved' }));
  if (base === 'a') {
    return values.map((v) =>
      v.key === K.elevation ? { ...v, lint: { severity: 'warning', message: 'Datum not stated: m NN assumed' } } : v,
    );
  }
  return values;
}

function toLayer(l: GenLayer): Layer {
  return {
    n: l.n, from: l.from, to: l.to,
    lithology: l.en, lithologyAsPrinted: l.de, din: l.din, dinNotation: l.notation,
    stratigraphicName: l.strat, engineeringSoilUnit: null, geologicAge: l.age,
    colour: null, consistency: null, moisture: null, weathering: null,
    // Rock layers were cored (they have TCR and RQD); for soils the log doesn't say.
    isCore: l.rock ? true : null,
    method: l.m, confidence: l.c,
    ...(l.spt ? { spt: l.spt } : {}),
    ...(l.tcr != null ? { tcr: l.tcr } : {}),
    ...(l.rqd != null ? { rqd: l.rqd } : {}),
  };
}

interface Printed {
  project: string; idRaw: string; dateRaw: string; methRaw: string; fdRaw: string; elevRaw: string;
  xLab: [string, string]; xA: string; xB: string; hasCoords: boolean; crsRaw: string;
}

/** The generated log page (prototype genPage). */
function genPage(page: number, p: Printed, layers: GenLayer[]): PageItem[] {
  const it = [
    T(24, 22, 'SCHICHTENVERZEICHNIS', 16, 700), T(24, 44, `nach DIN 4022 · Anlage ${page}`, 11), T(430, 22, 'Blatt 1 von 1'),
    T(24, 76, 'Bauvorhaben:'), T(130, 76, p.project), T(24, 98, 'Bohrung:'), T(130, 98, p.idRaw), T(300, 98, 'Datum:'), T(360, 98, p.dateRaw),
    T(24, 120, 'Verfahren:'), T(130, 120, p.methRaw), T(300, 120, 'Endteufe:'), T(380, 120, p.fdRaw), T(24, 142, 'Ansatzhöhe:'), T(130, 142, p.elevRaw),
  ];
  if (p.hasCoords) it.push(T(24, 164, p.xLab[0]), T(100, 164, p.xA), T(220, 164, p.xLab[1]), T(270, 164, p.xB));
  if (p.crsRaw) it.push(T(400, 164, p.crsRaw, 11));
  it.push(
    Ln(24, 188, 512, 1), Ln(24, 212, 512, 1), Ln(24, 760, 512, 1), Ln(24, 188, 1, 572), Ln(536, 188, 1, 573),
    Ln(100, 188, 1, 572), Ln(360, 188, 1, 572), Ln(460, 188, 1, 572),
    T(30, 194, 'bis m', 11, 700), T(110, 194, 'Benennung und Beschreibung', 11, 700), T(366, 194, 'SPT', 11, 700), T(466, 194, 'Bem.', 11, 700),
  );
  for (const l of layers) {
    it.push(T(30, l.y, cm(l.to)));
    l.lines.forEach((s, k) => it.push(T(110, l.y + k * 16, s)));
    if (l.spt) it.push(T(366, l.y, l.spt.raw, 11));
    l.rem.forEach((s, k) => it.push(T(466, l.y + k * 16, s)));
    it.push(Ln(24, l.y + 54, 512, 1, '#9a9a9a'));
  }
  it.push(T(110, 222 + layers.length * 64 + 6, '— Ende der Aufzeichnung —'));
  return it;
}
