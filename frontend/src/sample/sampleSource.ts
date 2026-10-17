// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.
/** DataSource over the fictional sample: in-memory, mutations persist for the session, simulated uploads. */
import type { DataSource } from '../data/DataSource';
import { ApiError, SaveError } from '../data/errors';
import { K } from '../domain/keys';
import { pageUsageText, placeholderPage } from '../domain/pages';
import { applyValuePatch } from '../domain/review';
import { deriveReviewStatus, isClean } from '../domain/status';
import type {
  Borehole,
  CrsCandidate,
  DocumentPage,
  DocumentSummary,
  ExtractedValue,
  Health,
  PageContent,
  PageItem,
  PageType,
} from '../domain/types';
import { crsCandidatesFor, EQ_DOC_ID, EQ_FILE, FIRST_GENERATED_PAGE, REPORT_TITLES, sampleDocuments, type PrintedIds } from './documents';
import { generateBorehole, makeSeeds, type Placement, type Seed } from './generate';
import { genericPage, pageMap } from './helpers';
import { bk07, bk07Sheet, BK07_PAGES, NB_DOC_ID, NB_FILE } from './neckarbogen';

/** Simulated upload timings, as in the prototype (ms after the drop). */
const STEP1_MS = 1800;
const STEP2_MS = 5200;

/** What the sample "server" reports at boot: fictional data, no providers. */
const SAMPLE_HEALTH: Health = {
  mode: 'sample',
  status: 'ok',
  version: 'sample',
  providers: { ocr: false, classifier: false, extractor: false, chat: false, geocoder: false },
  upload: { maxMb: 200, extensions: ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.docx', '.xlsx', '.csv'] },
};

interface DrawnPage { items: PageItem[]; label: string; type: PageType; page: DocumentPage }

/** A used log page of an archive file (archive files have no queue document). */
function archiveLogPage(n: number, ids: string[]): DocumentPage {
  return { ...placeholderPage(n), type: 'log', role: 'log_sheet', used: true, boreholeIds: ids, ocr: 'done', language: 'de', handwriting: 'none', classified: true };
}

/** Where a seed's log lives: Neckarbogen and Elbquerung in their queue documents, the rest in archive files. */
function placementOf(seed: Seed, rank: number): Placement {
  if (seed.nb) return { documentId: NB_DOC_ID, file: NB_FILE, page: FIRST_GENERATED_PAGE[NB_DOC_ID] + rank };
  if (seed.project === 'Elbquerung Ost') return { documentId: EQ_DOC_ID, file: EQ_FILE, page: FIRST_GENERATED_PAGE[EQ_DOC_ID] + rank };
  const slug = seed.project.toLowerCase().replace(/[^a-z]+/g, '_');
  return { documentId: slug, file: `${slug}_bohrprofile.pdf`, page: 1 + rank };
}

/** Builds every sample borehole (in prototype order), the log pages drawn for them and their printed IDs. */
function buildSample(): { boreholes: Borehole[]; drawn: Map<string, DrawnPage>; printed: PrintedIds } {
  const drawn = new Map<string, DrawnPage>();
  const printed: PrintedIds = new Map();
  for (const p of BK07_PAGES) {
    printed.set(`${NB_DOC_ID}:${p}`, ['BK 7']);
    drawn.set(`${NB_DOC_ID}:${p}`, {
      items: bk07Sheet(p), label: `page ${p} · sheet ${p - 6} of 2 · ${NB_FILE}`, type: 'log', page: archiveLogPage(p, ['BK 7']),
    });
  }
  const ranks = new Map<string, number>();
  const boreholes = makeSeeds().map((seed) => {
    if (seed.id === 'BK-07') return bk07(seed.lat, seed.lng);
    const rank = ranks.get(seed.project) ?? 0;
    ranks.set(seed.project, rank + 1);
    const at = placementOf(seed, rank);
    const { borehole, items } = generateBorehole(seed, at);
    const ids = [borehole.meta.aliases[0] ?? borehole.id];
    printed.set(`${at.documentId}:${at.page}`, ids);
    drawn.set(`${at.documentId}:${at.page}`, { items, label: `page ${at.page} · ${at.file}`, type: 'log', page: archiveLogPage(at.page, ids) });
    return borehole;
  });
  return { boreholes, drawn, printed };
}

/** A value without its flag reason. */
function withoutFlag(v: ExtractedValue): ExtractedValue {
  const { flag: _flag, ...rest } = v;
  return rest;
}

/** A borehole after a change: next revision, review status derived like the backend does. */
function revised(b: Borehole): Borehole {
  return { ...b, revision: b.revision + 1, reviewStatus: deriveReviewStatus(b.values) };
}

/**
 * Confirms a CRS for one borehole: status `confirmed`, its CRS value approved with the candidate name,
 * the position from the candidate's point (which puts it on the map), and the CRS question answered.
 * A candidate that contradicts the AI's guess marks the value as Edited.
 */
function confirmOn(b: Borehole, c: CrsCandidate): Borehole {
  const point = c.points.find((p) => p.uid === b.uid);
  const asked = b.crs.status === 'inferred' || b.crs.status === 'unknown';
  return revised({
    ...b,
    ...(point ? { lat: point.lat, lng: point.lng, onMap: true, unplottedReason: null } : {}),
    crs: { name: c.name, code: c.code, status: 'confirmed' },
    openClarifications: asked ? Math.max(0, b.openClarifications - 1) : b.openClarifications,
    values: b.values.map((v) =>
      v.key === K.crs
        ? { ...v, value: c.name, status: 'approved', state: 'ok', method: c.verdict === 'match' ? v.method : 'Edited' }
        : v,
    ),
  });
}

/** Creates the in-memory sample data source. */
export function createSampleSource(): DataSource {
  const { boreholes, drawn, printed } = buildSample();
  const byUid = new Map(boreholes.map((b) => [b.uid, b]));
  const candidates = new Map<string, CrsCandidate[]>();
  let docs = sampleDocuments(printed);

  const candidatesOf = (documentId: string) => {
    if (!candidates.has(documentId)) candidates.set(documentId, crsCandidatesFor(documentId, boreholes));
    return candidates.get(documentId) as CrsCandidate[];
  };
  const ofDocument = (documentId: string) => [...byUid.values()].filter((b) => b.documentId === documentId);

  return {
    kind: 'sample',

    async health() {
      return structuredClone(SAMPLE_HEALTH);
    },

    async load() {
      return structuredClone({ boreholes: [...byUid.values()], documents: docs });
    },

    async getBorehole(uid) {
      const b = byUid.get(uid);
      if (!b) throw new ApiError(404, 'borehole_not_found', `Borehole ${uid} not found.`);
      return structuredClone(b);
    },

    async documentBoreholes(documentId) {
      return structuredClone(ofDocument(documentId));
    },

    async getDocument(documentId) {
      const d = docs.find((x) => x.id === documentId);
      if (!d) throw new ApiError(404, 'document_not_found', `Document ${documentId} not found.`);
      return structuredClone(d);
    },

    async getPage(documentId, page): Promise<PageContent> {
      const doc = docs.find((d) => d.id === documentId);
      const own = drawn.get(`${documentId}:${page}`);
      if (own) {
        const usage = pageUsageText(doc?.pages[page - 1] ?? own.page);
        return { documentId, page, type: own.type, usage, label: own.label, items: own.items };
      }
      const p = doc?.pages[page - 1];
      if (!doc || !p) throw new ApiError(404, 'page_not_found', `Page ${page} of document ${documentId} not found.`);
      const title = REPORT_TITLES[documentId] ?? { project: doc.project, date: '' };
      return {
        documentId, page, type: p.type, usage: pageUsageText(p), label: `page ${page} · ${doc.name}`,
        items: genericPage(page, p.type, title),
      };
    },

    async upload(files, onUpdate, options) {
      files.forEach((f, k) => {
        const id = `u${Date.now()}${k}`;
        const n = 8 + (f.name.length % 14);
        const set = (patch: Partial<DocumentSummary>) => {
          docs = docs.map((d) => (d.id === id ? { ...d, ...patch } : d));
          const doc = docs.find((d) => d.id === id);
          if (doc) onUpdate(structuredClone(doc));
        };
        const opts = { language: 'de', handwriting: 'none' as const };
        const first: DocumentSummary = {
          id, name: f.name, project: options?.project ?? 'New upload', status: 'classifying',
          pages: pageMap('CT' + '?'.repeat(n - 2), opts),
          step: 0, progress: { pagesTotal: n, pagesClassified: 2, pagesOcrTotal: 0, pagesOcrDone: 0, boreholesExtracted: 0 },
          counts: null, completeness: null, reviewBoreholeUid: null, openClarifications: 0, duplicateOf: null, error: null,
          uploaded: true, simulated: true,
        };
        docs = [first, ...docs];
        onUpdate(structuredClone(first));
        const half = Math.ceil(n / 2);
        setTimeout(
          () =>
            set({
              status: 'extracting', step: 1,
              pages: pageMap('CT' + 'L'.repeat(half - 2) + '?'.repeat(n - half), opts),
              progress: { pagesTotal: n, pagesClassified: half, pagesOcrTotal: half - 2, pagesOcrDone: 0, boreholesExtracted: 0 },
            }),
          STEP1_MS,
        );
        setTimeout(
          () =>
            set({
              status: 'needs_review', step: 2,
              pages: pageMap('CT' + 'L'.repeat(n - 6) + 'BBBP', opts),
              progress: { pagesTotal: n, pagesClassified: n, pagesOcrTotal: n - 3, pagesOcrDone: n - 3, boreholesExtracted: Math.max(1, n - 9) },
              counts: { boreholes: Math.max(1, n - 9), layers: (n - 6) * 4, spt: n - 4, groundwater: Math.max(0, n - 10) },
              completeness: { listed: Math.max(1, n - 9), idPrefix: 'NEW-', missing: [], unexpected: [], lint: [] },
            }),
          STEP2_MS,
        );
      });
    },

    async updateValue(uid, key, patch) {
      const b = byUid.get(uid);
      if (!b) throw new SaveError(`Borehole ${uid} not found.`, null, 'borehole_not_found');
      if (!b.values.some((v) => v.key === key)) {
        throw new SaveError(`Value ${key} of ${b.id} not found.`, structuredClone(b), 'path_not_found');
      }
      const patched = applyValuePatch(b, key, patch);
      // Like the backend, approve and reset clear the value's flag.
      const unflag = patch.status === 'approved' || patch.status === 'unreviewed';
      const next = revised(unflag ? { ...patched, values: patched.values.map((v) => (v.key === key ? withoutFlag(v) : v)) } : patched);
      byUid.set(uid, next);
      return structuredClone(next);
    },

    async approveClean(documentId, dryRun) {
      let count = 0;
      for (const b of ofDocument(documentId)) {
        const clean = b.values.filter(isClean).length;
        count += clean;
        if (!dryRun && clean) {
          byUid.set(b.uid, revised({ ...b, values: b.values.map((v) => (isClean(v) ? { ...v, status: 'approved' } : v)) }));
        }
      }
      return count;
    },

    async retry(documentId) {
      const d = docs.find((x) => x.id === documentId);
      if (d?.status === 'failed') {
        docs = docs.map((x) => (x.id === documentId ? { ...x, status: 'queued', step: 0, error: null } : x));
      }
    },

    async crsCandidates(documentId) {
      return structuredClone(candidatesOf(documentId));
    },

    async confirmCrs(documentId, { code, swapAxes }) {
      const c = candidatesOf(documentId).find((x) => x.code === code && x.swapAxes === swapAxes);
      if (!c || c.verdict === 'out_of_range') {
        throw new ApiError(422, 'crs_invalid', `${code} cannot place the boreholes of this document.`);
      }
      // Like the backend, only boreholes with printed coordinates get the system; the count says how many.
      let updated = 0;
      for (const b of ofDocument(documentId)) {
        if (b.meta.localX == null || b.meta.localY == null) continue;
        byUid.set(b.uid, confirmOn(b, c));
        updated += 1;
      }
      docs = docs.map((d) => (d.id === documentId ? { ...d, openClarifications: Math.max(0, d.openClarifications - 1) } : d));
      return updated;
    },
  };
}
