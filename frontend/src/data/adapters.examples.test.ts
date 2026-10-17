/**
 * The adapters over every backend contract example (<repo>/contracts/examples, fictional): every
 * record, list item and document adapts, and the adapted domain objects keep what the server sent,
 * invent nothing and drop nothing a reviewer needs. Skips while the examples are not on this branch.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { K } from '../domain/keys';
import { pageUsageText } from '../domain/pages';
import { formatSpt } from '../domain/spt';
import type { Borehole, ExtractedValue } from '../domain/types';
import { EXAMPLES_MISSING, EXAMPLES_PRESENT, example, examplesOf } from '../test/contract/examples';
import {
  adaptArea,
  adaptBorehole,
  adaptClarification,
  adaptClarifications,
  adaptCrsCandidates,
  adaptDocument,
  adaptFeatures,
  adaptFilter,
  adaptHealth,
  adaptLiveEvent,
  adaptPlaces,
  adaptResultSet,
  toWireFilter,
  valueAt,
  type AdaptedBorehole,
  type WireBorehole,
  type WireBoreholeList,
  type WireClarification,
  type WireCrsCandidate,
  type WireDocument,
  type WireDocumentList,
  type WireFeatureCollection,
  type WireFilter,
  type WireHealth,
  type WirePlace,
  type WireResultSet,
} from './adapters';

/** Every BoreholeRecord example and every item of every BoreholeList example, as [label, record]. */
function allRecords(): [string, WireBorehole][] {
  const single = examplesOf<WireBorehole>('BoreholeRecord');
  const listed = examplesOf<WireBoreholeList>('BoreholeList').flatMap(([file, list]) =>
    list.boreholes.map((r, i): [string, WireBorehole] => [`${file} [${i}]`, r]),
  );
  return [...single, ...listed];
}

/** Every Document example and every item of every DocumentList example, as [label, document]. */
function allDocuments(): [string, WireDocument][] {
  const single = examplesOf<WireDocument>('Document');
  const listed = examplesOf<WireDocumentList>('DocumentList').flatMap(([file, list]) =>
    list.documents.map((d, i): [string, WireDocument] => [`${file} [${i}]`, d]),
  );
  return [...single, ...listed];
}

const val = (b: Borehole, key: string) => b.values.find((v) => v.key === key);

/**
 * Every scalar in the record body (not provenance or lint): what a value's text may come from. A list
 * of scalars also counts as its items joined with ", " (how a list value is shown, e.g. SPT increments).
 */
function bodyScalars(rec: WireBorehole): { strings: Set<string>; numbers: number[]; booleans: boolean } {
  const strings = new Set<string>();
  const numbers: number[] = [];
  let booleans = false;
  const walk = (x: unknown) => {
    if (x == null) return;
    if (typeof x === 'string') strings.add(x);
    else if (typeof x === 'number') numbers.push(x);
    else if (typeof x === 'boolean') booleans = true;
    else if (Array.isArray(x)) {
      if (x.length && x.every((i) => typeof i === 'string' || typeof i === 'number')) strings.add(x.join(', '));
      x.forEach(walk);
    } else if (typeof x === 'object') Object.values(x).forEach(walk);
  };
  const { provenance: _p, lint: _l, ...body } = rec;
  walk(body);
  return { strings, numbers, booleans };
}

/** True when a displayed text part comes from the record: a string as sent, yes / no for a boolean, or a number (2-decimal display allowed). */
function fromRecord(part: string, s: ReturnType<typeof bodyScalars>): boolean {
  if (s.strings.has(part)) return true;
  if ((part === 'yes' || part === 'no') && s.booleans) return true;
  if (!/^-?\d+(\.\d+)?$/.test(part)) return false;
  const n = Number(part);
  return s.numbers.some((x) => Math.abs(x - n) <= 0.005 + 1e-9);
}

/** Domain method of a wire method. */
const METHOD = { read: 'Read', ocr: 'OCR', derived: 'Derived', guessed: 'Guessed', edited: 'Edited' } as const;

/** The provenance entries a value stands for (its patch target paths). */
const provOf = (a: AdaptedBorehole, rec: WireBorehole, v: ExtractedValue) => (a.targets[v.key]?.paths ?? []).map((p) => rec.provenance[p]);

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe.skipIf(!EXAMPLES_PRESENT)(`adapters on the backend examples${EXAMPLES_PRESENT ? '' : ` — skipped: ${EXAMPLES_MISSING}`}`, () => {
  describe('boreholes: every BoreholeRecord*.json and every item of BoreholeList*.json', () => {
    it('has records to check', () => {
      expect(allRecords().length).toBeGreaterThanOrEqual(6);
    });

    it.each(allRecords())('%s adapts, keeping identity, status, revision and position as sent', (_, rec) => {
      const { borehole: b } = adaptBorehole(rec);
      const co = rec.metadata.coordinates ?? {};
      expect(b).toMatchObject({
        uid: rec.uid,
        id: rec.metadata.borehole_id,
        documentId: rec.document_id,
        sourceFile: rec.source_file,
        revision: rec.revision,
        reviewStatus: rec.review_status,
        onMap: rec.plotted,
        // Reason codes stay codes (the UI maps them to labels).
        unplottedReason: rec.unplotted_reason ?? null,
        openClarifications: rec.open_clarifications ?? 0,
        // null stays null: never 0, never (0, 0).
        lat: co.latitude ?? null,
        lng: co.longitude ?? null,
        finalDepth: rec.metadata.borehole_depth_m ?? null,
        rockHead: rec.rock_head_m ?? null,
        crs: { name: co.coordinate_system ?? null, code: co.crs_code ?? null, status: rec.crs_status },
      });
      expect(b.meta).toEqual({
        aliases: rec.metadata.aliases ?? [],
        elevationDatum: rec.metadata.elevation_datum ?? null,
        depthOrigin: rec.metadata.depth_origin ?? null,
        depthSource: rec.metadata.borehole_depth_source ?? null,
        xRaw: co.x_raw ?? null,
        yRaw: co.y_raw ?? null,
        axisLabelsRaw: co.axis_labels_raw ?? null,
        localX: co.local_x ?? null,
        localY: co.local_y ?? null,
      });
      if (!rec.plotted) expect(rec.unplotted_reason, `${rec.uid} is not plotted but has no reason`).not.toBeNull();
    });

    it.each(allRecords())('%s: every provenance key is the target of exactly one value, and only provenance keys are targets', (_, rec) => {
      const { borehole: b, targets } = adaptBorehole(rec);
      const targeted = Object.values(targets).flatMap((t) => t.paths);
      expect([...targeted].sort()).toEqual(Object.keys(rec.provenance).sort());
      expect(new Set(targeted).size).toBe(targeted.length);
      for (const [key, t] of Object.entries(targets)) {
        expect(val(b, key)?.hasProvenance, key).toBe(true);
        for (const p of t.paths) expect(rec.provenance, `${key} → ${p}`).toHaveProperty([p]);
      }
      // A value without a target has no provenance entry: it can't be saved or approved.
      for (const v of b.values) expect(v.hasProvenance, v.key).toBe(v.key in targets);
    });

    it.each(allRecords())('%s: a sourced value has its page (or its cell, with page and box null)', (_, rec) => {
      const a = adaptBorehole(rec);
      for (const v of a.borehole.values.filter((x) => x.hasProvenance)) {
        const ps = provOf(a, rec, v);
        const cell = ps.find((p) => p.cell)?.cell;
        if (cell) {
          expect([v.cell, v.page, v.box], v.key).toEqual([cell, null, null]);
          continue;
        }
        expect(v.cell, v.key).toBeUndefined();
        const pages = ps.map((p) => p.page).filter((p) => p != null);
        // A value has a page whenever its provenance names one (guessed or not-in-source values may have none).
        if (pages.length) expect(pages, v.key).toContain(v.page);
        else expect(v.page, v.key).toBeNull();
        if (v.box) expect(ps.some((p) => p.box != null && p.page === v.page), v.key).toBe(true);
      }
    });

    it.each(allRecords())('%s: method, status, state, flag, readings and confidence come from the provenance; null confidence stays null', (_, rec) => {
      const a = adaptBorehole(rec);
      for (const v of a.borehole.values) {
        const ps = provOf(a, rec, v);
        if (!ps.length) {
          expect([v.method, v.confidence, v.status], v.key).toEqual([null, null, 'unreviewed']);
          continue;
        }
        const confs = ps.map((p) => p.confidence);
        expect(v.confidence, v.key).toBe(confs.some((c) => c == null) ? null : Math.min(...(confs as number[])));
        expect(ps.map((p) => METHOD[p.method]), v.key).toContain(v.method);
        if (ps.length === 1) {
          const p = ps[0];
          expect(v.status, v.key).toBe(p.status);
          expect(v.state, v.key).toBe(p.state === 'ok' ? 'ok' : p.state === 'not_in_source' ? 'not in source' : 'illegible');
          expect(v.flag ?? null, v.key).toBe(p.flag ?? null);
          expect(v.readings ?? [], v.key).toEqual((p.readings ?? []).map((r) => ({ reader: r.reader, text: r.text, confidence: r.confidence ?? null })));
        }
      }
      expect(a.borehole.values.filter((v) => v.confidence === 0)).toEqual([]);
    });

    it.each(allRecords())('%s: no value text is invented; every shown text comes from the record', (_, rec) => {
      const { borehole: b } = adaptBorehole(rec);
      const s = bodyScalars(rec);
      for (const v of b.values) {
        if (!v.value || v.kind === 'spt') continue;
        // Only the X / Y row joins two fields; other texts may contain " / " themselves ("ETRS89 / UTM 32N").
        const parts = v.key === K.xy ? v.value.split(' / ') : [v.value];
        for (const part of parts) expect(fromRecord(part, s), `${v.key}: "${part}"`).toBe(true);
      }
      // The structured model holds exactly the record's numbers.
      expect(b.layers.map((l) => [l.from, l.to, l.din, l.dinNotation, l.isCore, l.tcr ?? null, l.rqd ?? null])).toEqual(
        rec.stratigraphy.map((l) => [l.depth_from_m, l.depth_to_m, l.din4023_code ?? null, l.din4023_notation ?? null, l.is_core ?? null, l.core_recovery_pct ?? null, l.rqd_pct ?? null]),
      );
      expect(b.groundwater.map((g) => [g.type, g.depth, g.elevation, g.date, g.raw])).toEqual(
        rec.groundwater.map((g) => [g.type, g.depth_m ?? null, g.elevation_m ?? null, g.date ?? null, g.raw ?? null]),
      );
      expect(b.samples.map((x) => [x.name, x.typeCode, x.from, x.to])).toEqual(
        (rec.samples ?? []).map((x) => [x.name, x.type_code ?? null, x.depth_from_m ?? null, x.depth_to_m ?? null]),
      );
      expect(b.testResults.map((t) => [t.name, t.value, t.qualifier, t.sampleName, t.depth])).toEqual(
        (rec.test_results ?? []).map((t) => [t.name, t.value ?? null, t.qualifier ?? null, t.sample_name ?? null, t.depth_m ?? null]),
      );
    });

    it.each(allRecords())('%s: DIN codes are kept exactly, case included; SPT is kept as sent', (_, rec) => {
      const { borehole: b } = adaptBorehole(rec);
      rec.stratigraphy.forEach((l, i) => {
        const layer = b.layers[i];
        expect(layer.din).toBe(l.din4023_code ?? null);
        expect(val(b, K.lithology(i + 1))?.din ?? null).toBe(l.din4023_code ?? null);
        const hasSpt = l.spt_raw != null || l.spt_n_value != null || !!l.spt_refusal || !!l.spt_increments?.length;
        expect(!!layer.spt, `layer ${i + 1}`).toBe(hasSpt);
        if (!layer.spt) return;
        expect(layer.spt).toMatchObject({ raw: l.spt_raw ?? '', depth: l.spt_depth_m ?? null, refusal: !!l.spt_refusal });
        // A refusal is never an N value.
        if (l.spt_refusal) expect(layer.spt.n).toBeUndefined();
        else expect(layer.spt.n ?? null).toBe(l.spt_n_value ?? null);
        const row = val(b, K.spt(i + 1));
        expect(row?.value).toBe(formatSpt(layer.spt));
        expect(row?.label).toBe(l.spt_depth_m == null ? 'SPT (depth not stated)' : `SPT @ ${l.spt_depth_m.toFixed(2)} m`);
      });
    });

    it.each(allRecords())('%s: FE-PROV-1 the lithology row targets english_lithology when tracked, else original_description', (_, rec) => {
      const { borehole: b, targets } = adaptBorehole(rec);
      rec.stratigraphy.forEach((l, i) => {
        const en = `stratigraphy[${i}].english_lithology`;
        const desc = `stratigraphy[${i}].original_description`;
        const path = en in rec.provenance ? en : desc in rec.provenance ? desc : null;
        const row = val(b, K.lithology(i + 1));
        expect(targets[K.lithology(i + 1)]?.paths ?? null, `layer ${i + 1}`).toEqual(path ? [path] : null);
        if (l.english_lithology) expect(row?.value).toBe(l.english_lithology);
        if (row) expect(row.raw).toBe((path && rec.provenance[path].raw) || l.original_description || '');
        // The description has its own row only when the lithology row does not stand for it.
        expect(b.values.some((v) => v.key === desc), `layer ${i + 1}`).toBe(path !== desc && desc in rec.provenance);
        expect([b.layers[i].method, b.layers[i].confidence]).toEqual([row?.method ?? null, row?.confidence ?? null]);
      });
    });

    it.each(allRecords())('%s: DV-11, DV-14 a value names its source document only when it is another one; no invented page', (_, rec) => {
      const a = adaptBorehole(rec);
      for (const v of a.borehole.values) {
        const ps = provOf(a, rec, v);
        const source = ps.find((p) => p.cell) ?? ps.find((p) => p.page != null) ?? ps[0];
        const other = source?.document_id && source.document_id !== rec.document_id ? source.document_id : undefined;
        expect(v.documentId, v.key).toBe(other);
      }
      expect(a.borehole.primaryPage).toBe(a.borehole.pages[0] ?? null);
    });

    it.each(allRecords())('%s: uiv-B3, uiv-B4, uiv-B7, FE-DISP-2 units, notes and read-only values', (_, rec) => {
      const { borehole: b, targets } = adaptBorehole(rec);
      const elevation = val(b, K.elevation);
      if (elevation) {
        expect(elevation.unit).toBe('m');
        expect(elevation.note).toBe(rec.metadata.elevation_datum ? `datum: ${rec.metadata.elevation_datum}` : undefined);
      }
      for (const v of b.values) {
        if (v.unit.includes('bgl')) expect(rec.metadata.depth_origin, v.key).toBe('ground');
        const paths = targets[v.key]?.paths ?? [];
        if (paths.includes('metadata.coordinates.crs_code')) expect(v.readOnlyReason, v.key).toBe('Set the coordinate system with CHOOSE CRS…');
        // Generic rows (keyed by their path): depths in m, latitude and longitude in degrees.
        if (v.key !== paths[0]) continue;
        if (/_m$/.test(v.key)) expect(v.unit, v.key).toBe('m');
        if (/\.(latitude|longitude)$/.test(v.key)) {
          expect(v.unit, v.key).toBe('°');
          if (v.method === 'Derived') expect(v.value.split('.')[1]?.length ?? 0, v.key).toBeLessThanOrEqual(7);
          else expect(v.value, v.key).toBe(String(valueAt(rec, v.key)));
        }
      }
    });
  });

  describe('boreholes: the backend examples shaped like the seed (layer text tracked at original_description)', () => {
    it('every lithology row is reviewable there; no duplicate description row', () => {
      const rec = example<WireBorehole>('BoreholeRecord.full.json');
      for (const path of Object.keys(rec.provenance)) if (path.endsWith('.english_lithology')) delete rec.provenance[path];
      const { borehole: b, targets, unsourced } = adaptBorehole(rec);
      const tracked = rec.stratigraphy.filter((_, i) => `stratigraphy[${i}].original_description` in rec.provenance);
      expect(tracked.length).toBeGreaterThan(0);
      rec.stratigraphy.forEach((l, i) => {
        const desc = rec.provenance[`stratigraphy[${i}].original_description`];
        if (!desc) return;
        expect(targets[K.lithology(i + 1)].paths).toEqual([`stratigraphy[${i}].original_description`]);
        expect(val(b, K.lithology(i + 1))).toMatchObject({
          hasProvenance: true, value: l.english_lithology, raw: desc.raw, method: METHOD[desc.method], confidence: desc.confidence,
        });
      });
      expect(b.values.filter((v) => v.label === 'Description as printed')).toEqual([]);
      const untracked = rec.stratigraphy.flatMap((l, i) =>
        tracked.includes(l) || l.english_lithology == null ? [] : [`stratigraphy[${i}].english_lithology`]);
      expect(unsourced.filter((p) => p.includes('lithology') || p.includes('description'))).toEqual(untracked);
    });
  });

  describe('boreholes: what the full example pins down', () => {
    const full = () => example<WireBorehole>('BoreholeRecord.full.json');

    it('keeps mixed-case DIN keys apart (mG medium gravel is not Mg)', () => {
      const { borehole: b } = adaptBorehole(full());
      expect(b.layers.map((l) => l.din)).toEqual(['Mu', 'mG', 'T', 'U', 'Kst']);
    });

    it('labels an SPT without a stated depth "depth not stated" and never invents one', () => {
      const rec = full();
      rec.stratigraphy[1].spt_depth_m = null;
      const { borehole: b } = adaptBorehole(rec);
      expect(b.layers[1].spt?.depth).toBeNull();
      expect(val(b, K.spt(2))).toMatchObject({ label: 'SPT (depth not stated)', value: 'N = 20' });
      expect(JSON.stringify(b.values.filter((v) => v.layer === 2))).not.toMatch(/SPT @|2\.00 m/);
    });

    it('keeps a refusal without N as a refusal with its raw text', () => {
      const { borehole: b, targets } = adaptBorehole(full());
      expect(b.layers[3].spt).toEqual({ raw: '50/120', depth: 12, refusal: true, penetrationCm: 12 });
      expect(val(b, K.spt(4))).toMatchObject({ value: 'refusal · 50/120', refusal: true, label: 'SPT @ 12.00 m' });
      // spt_raw is the row; the refusal flag has its own provenance entry and its own row.
      expect(targets[K.spt(4)].paths).toEqual(['stratigraphy[3].spt_raw']);
      expect(targets['stratigraphy[3].spt_refusal']).toEqual({ paths: ['stratigraphy[3].spt_refusal'], type: 'boolean' });
    });

    it('shows the edited UCS with its machine value, the handwriting readings and the spreadsheet cell', () => {
      const { borehole: b } = adaptBorehole(full());
      expect(val(b, K.ucs(5))).toMatchObject({ value: '42.5', aiValue: '4.25', method: 'Edited', status: 'approved' });
      expect(val(b, K.bottom(3))?.readings).toEqual([
        { reader: 'ocr', text: '9,50', confidence: 0.58 },
        { reader: 'second_read', text: '9,80', confidence: 0.71 },
      ]);
      expect(val(b, K.test(1))).toMatchObject({ cell: 'Logdata!C5', page: null, box: null, value: '41', raw: '41' });
      // DV-11: that cell is in the lab spreadsheet (Document.spreadsheet.json), not in the record's own document.
      expect(val(b, K.test(1))?.documentId).toBe(example<WireDocument>('Document.spreadsheet.json').document_id);
      expect(b.values.filter((v) => v.documentId).map((v) => v.key)).toEqual([K.test(1)]);
      expect(val(b, K.test(3))).toMatchObject({ value: '', page: 9, hasProvenance: true });
    });

    it('lands both lint findings on their rows', () => {
      const { borehole: b } = adaptBorehole(full());
      expect(val(b, K.rqd(5))?.lint).toEqual({ severity: 'error', message: 'RQD 104 % is above 100 %. The printed value is kept.' });
      expect(val(b, K.spt(2))?.lint?.severity).toBe('warning');
    });

    it('uses the local X / Y pair the provenance has and keeps WGS84 as its own rows', () => {
      const { borehole: b, targets } = adaptBorehole(full());
      expect(val(b, K.xy)).toMatchObject({ value: '467512.3 / 5969830.15', raw: '467 512,30 / 5 969 830,15' });
      expect(targets[K.xy].pair).toEqual(['metadata.coordinates.local_x', 'metadata.coordinates.local_y']);
      expect(val(b, 'metadata.coordinates.latitude')).toMatchObject({ value: '53.875923', method: 'Derived', page: 5, box: null });
    });

    it('keeps unknown coordinates and depth null, never 0', () => {
      const rec = full();
      Object.assign(rec.metadata.coordinates as object, { latitude: null, longitude: null, local_x: null, local_y: null });
      rec.metadata.borehole_depth_m = null;
      for (const p of ['metadata.coordinates.latitude', 'metadata.coordinates.longitude', 'metadata.coordinates.local_x', 'metadata.coordinates.local_y', 'metadata.borehole_depth_m']) {
        rec.provenance[p].ai_value = null;
        rec.provenance[p].confidence = null;
      }
      const { borehole: b } = adaptBorehole(rec);
      expect([b.lat, b.lng, b.finalDepth, b.meta.localX, b.meta.localY]).toEqual([null, null, null, null, null]);
      expect(val(b, K.finalDepth)).toMatchObject({ value: '', aiValue: '', confidence: null });
      expect(val(b, K.xy)).toMatchObject({ value: '', confidence: null });
    });
  });

  describe('documents: every Document*.json and every item of DocumentList*.json', () => {
    it('has documents to check', () => {
      expect(allDocuments().length).toBeGreaterThanOrEqual(8);
    });

    it.each(allDocuments())('%s adapts with one page per page_count; unclassified pages are placeholders', (_, d) => {
      const doc = adaptDocument(d);
      expect(doc).toMatchObject({
        id: d.document_id, name: d.file_name, project: d.project ?? '', status: d.status,
        openClarifications: d.open_clarifications ?? 0, duplicateOf: d.duplicate_of ?? null, counts: d.found ?? null,
      });
      expect(doc.pages).toHaveLength(d.page_count ?? d.pages.length);
      expect(doc.pages.map((p) => p.n)).toEqual(doc.pages.map((_p, i) => i + 1));
      for (const p of d.pages) {
        const page = doc.pages[p.n - 1];
        if (p.type === 'unknown' && p.role == null) {
          // The backend lists a page it hasn't classified yet as {type: unknown, used: false, ocr: pending}.
          expect(page.classified, `page ${p.n}`).toBe(false);
          expect(pageUsageText(page)).toBe('not classified yet');
          continue;
        }
        expect(page, `page ${p.n}`).toEqual({
          n: p.n, type: p.type, role: p.role ?? null, used: p.used, unusedReason: p.unused_reason ?? null,
          boreholeIds: p.borehole_ids ?? [], sheetLabel: p.sheet_label ?? null, handwriting: p.handwriting ?? null,
          language: p.language ?? null, ocr: p.ocr ?? null,
          duplicateOf: p.duplicate_of ? { documentId: p.duplicate_of.document_id, n: p.duplicate_of.n } : null, classified: true,
        });
      }
      if (d.status === 'failed') expect(doc.error).toBe(d.error || 'Extraction failed');
      else expect(doc.error).toBeNull();
      // CONTRACT-1: a failed document failed during extraction once every page was classified.
      if (d.status === 'failed') {
        const classified = !!d.progress && d.progress.pages_total > 0 && d.progress.pages_classified >= d.progress.pages_total;
        expect(doc.step).toBe(classified ? 1 : 0);
      }
      const pr = d.progress;
      expect(doc.progress).toEqual(
        pr ? { pagesTotal: pr.pages_total, pagesClassified: pr.pages_classified, pagesOcrTotal: pr.pages_ocr_total, pagesOcrDone: pr.pages_ocr_done, boreholesExtracted: pr.boreholes_extracted } : null,
      );
      const c = d.completeness;
      if (c) expect(doc.completeness).toMatchObject({ listed: c.expected_ids.length, expectedIds: c.expected_ids, missing: c.missing, unexpected: c.unexpected });
      else expect(doc.completeness).toBeNull();
    });

    it('shows the classifying example with 5 classified pages and 3 placeholders', () => {
      const doc = adaptDocument(example<WireDocument>('Document.classifying.json'));
      expect(doc.pages.map((p) => p.classified)).toEqual([true, true, true, true, true, false, false, false]);
      expect(doc.step).toBe(0);
    });

    it('CONTRACT-1: the failed example failed during text recognition, after every page was classified', () => {
      const doc = adaptDocument(example<WireDocument>('Document.failed.json'));
      expect([doc.status, doc.step, doc.progress?.pagesClassified, doc.progress?.pagesTotal]).toEqual(['failed', 1, 1, 1]);
    });

    it('keeps a page duplicated inside the same document and a blank page of type unknown as classified', () => {
      const doc = adaptDocument(example<WireDocument>('Document.needs_review.json'));
      expect(pageUsageText(doc.pages[12])).toBe('unused: duplicate of page 8');
      expect(doc.pages[11]).toMatchObject({ type: 'unknown', role: 'blank', classified: true });
    });

    it('event document.updated carries a full Document that adapts like one', () => {
      const d = example<WireDocument>('events/document.updated.json');
      expect(adaptDocument(d).pages).toHaveLength(d.page_count ?? 0);
    });
  });

  describe('M2: map features, filters, result sets, places, clarifications', () => {
    it.each(examplesOf<WireFeatureCollection>('BoreholeFeatureCollection'))('%s: every feature adapts, [lon, lat] as sent, nothing left out', (_, fc) => {
      const features = adaptFeatures(fc);
      expect(features).toHaveLength(fc.features.length);
      fc.features.forEach((f, i) => {
        const p = f.properties;
        expect(features[i]).toEqual({
          uid: p.uid, id: p.borehole_id, project: p.project_name ?? null, documentId: p.document_id ?? null,
          lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], depth: p.borehole_depth_m ?? null,
          reviewStatus: p.review_status, crsStatus: p.crs_status, revision: p.revision ?? null,
          attention: p.attention ?? (p.open_clarifications ?? 0) > 0, openClarifications: p.open_clarifications ?? 0,
        });
      });
    });

    it.each(examplesOf<WireFilter>('BoreholeFilter'))('%s reads into a filter and is sent back the same (unset fields left out)', (_, w) => {
      const filter = adaptFilter(w);
      expect(filter.includeUnreviewed).toBe(w.include_unreviewed ?? false);
      if (w.area) expect(filter.area?.type).toBe(w.area.type);
      const back = toWireFilter(filter);
      expect(back).toEqual(Object.fromEntries(Object.entries(w).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length))));
    });

    it('BoreholeFilter.circle.json: the circle is {center [lon, lat], radiusM}', () => {
      const filter = adaptFilter(example<WireFilter>('BoreholeFilter.circle.json'));
      expect(filter.area).toEqual({ type: 'circle', center: [-1.9361, 53.6668], radiusM: 2500 });
      expect(filter.reviewStatus).toEqual(['approved']);
    });

    it.each(examplesOf<WireResultSet>('ResultSet'))('%s adapts with its counts, bbox, echoed area and definition', (_, rs) => {
      const set = adaptResultSet(rs);
      expect(set).toMatchObject({
        id: rs.result_set_id, count: rs.count, locatedCount: rs.located_count, unlocatedCount: rs.unlocated_count,
        excludedUnreviewed: rs.excluded_unreviewed ?? null, uids: rs.uids, bbox: rs.bbox, createdAt: rs.created_at,
      });
      expect(set.definition).toEqual(adaptFilter(rs.definition));
      expect(set.area).toEqual(rs.area == null ? null : adaptArea(rs.area));
    });

    it('ResultSet.empty_area.json: no member, the bbox of the searched area', () => {
      const set = adaptResultSet(example<WireResultSet>('ResultSet.empty_area.json'));
      expect([set.count, set.bbox, set.area]).toEqual([0, [-1.8, 53.6, -1.75, 53.63], { type: 'bbox', bbox: [-1.8, 53.6, -1.75, 53.63] }]);
    });

    it.each(examplesOf<WirePlace[]>('PlaceCandidate'))('%s: every candidate adapts in order, lon as lng', (_, list) => {
      const places = adaptPlaces(list);
      expect(places.map((p) => [p.label, p.lat, p.lng, p.source, p.boreholeCount])).toEqual(
        list.map((p) => [p.label, p.lat, p.lon, p.source, p.borehole_count ?? null]),
      );
    });

    it.each(examplesOf<WireClarification>('Clarification'))('%s adapts: fields, options with evidence, defaults as sent', (_, c) => {
      const q = adaptClarification(c);
      expect(q).not.toBeNull();
      expect(q).toMatchObject({
        id: c.clarification_id, kind: c.kind, status: c.status, documentId: c.document_id, boreholeUids: c.borehole_uids ?? [],
        path: c.path ?? null, question: c.question, answer: c.answer ?? null, answeredBy: c.answered_by ?? null,
        createdAt: c.created_at, resolvedAt: c.resolved_at ?? null,
      });
      c.fields.forEach((f, i) => {
        const field = q?.fields[i];
        expect(field).toMatchObject({ name: f.name, widget: f.widget, label: f.label, help: f.help ?? null, required: f.required ?? false });
        expect(field?.unitOptions).toEqual(f.unit_options ?? []);
        expect(field?.default).toEqual('default' in f ? f.default : undefined);
        expect(field?.options.map((o) => [o.value, o.label, o.evidence?.page ?? null])).toEqual(
          (f.options ?? []).map((o) => [o.value, o.label, o.evidence?.page ?? null]),
        );
      });
      expect(q?.evidence.map((e) => [e.documentId, e.page, e.box && [e.box.x, e.box.y, e.box.w, e.box.h], e.snippet])).toEqual(
        c.evidence.map((e) => [e.document_id, e.page, e.box ?? null, e.snippet ?? null]),
      );
    });

    it('the clarification examples cover every widget and every kind', () => {
      const all = adaptClarifications(examplesOf<WireClarification>('Clarification').map(([, c]) => c));
      expect(new Set(all.flatMap((c) => c.fields.map((f) => f.widget)))).toEqual(
        new Set(['text', 'number_unit', 'select', 'boolean', 'map_point', 'choose_reading', 'crs_picker', 'page_range']),
      );
      expect(new Set(all.map((c) => c.kind)).size).toBe(9);
    });

    it('events/clarification.created.json carries a question that adapts like a listed one', () => {
      const data = example<WireClarification>('events/clarification.created.json');
      const event = adaptLiveEvent('clarification.created', data);
      expect(event).toEqual({ type: 'clarification.created', clarification: adaptClarification(data) });
      expect(event && event.type === 'clarification.created' && event.clarification.fields[0].options[1].evidence?.snippet).toBe('9,80');
    });
  });

  describe('health and CRS candidates', () => {
    it.each(examplesOf<WireHealth>('Health'))('%s adapts as sent', (_, h) => {
      expect(adaptHealth(h)).toEqual({
        mode: h.mode, status: h.status, version: h.version, providers: h.providers,
        upload: { maxMb: h.upload.max_mb, extensions: h.upload.extensions },
      });
    });

    it('keeps two candidates of one EPSG code apart by swap_axes, with verdict, score and note', () => {
      const list = adaptCrsCandidates(example<WireCrsCandidate[]>('CrsCandidate.list.json'));
      expect(list.map((c) => [c.code, c.swapAxes, c.verdict, c.score])).toEqual([
        ['EPSG:27700', false, 'match', 0.94], ['EPSG:27700', true, 'shifted', 0.31], ['EPSG:25830', false, 'out_of_range', 0.02],
      ]);
      expect(list[0].points).toEqual([{ uid: 'bh_01M54CX9K86N0N3D5HSA8R6AQ7', lat: 53.660458, lng: -1.949844 }]);
      expect(list.every((c) => c.note)).toBe(true);
    });
  });
});
