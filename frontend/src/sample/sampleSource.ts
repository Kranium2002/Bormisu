// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.
/**
 * DataSource over the fictional sample: in-memory, mutations persist for the session, simulated
 * uploads (byte progress, then document.updated events to the subscribers). Map features, result
 * sets, place search and clarification questions follow the backend's semantics (./query,
 * ./clarifications); the open-question counts of boreholes and documents are the unresolved questions
 * that name them, and every change a question brings is announced as live events.
 */
import type { DataSource } from '../data/DataSource';
import { ApiError, SaveError, UploadCancelledError } from '../data/errors';
import { K } from '../domain/keys';
import { pageUsageText, placeholderPage } from '../domain/pages';
import { applyValuePatch } from '../domain/review';
import { deriveReviewStatus, isClean } from '../domain/status';
import type {
  Borehole,
  Clarification,
  CrsCandidate,
  DocumentPage,
  DocumentSummary,
  ExtractedValue,
  Health,
  LiveEvent,
  PageContent,
  PageItem,
  PageType,
  ResultSet,
  UploadResult,
} from '../domain/types';
import { PAGE_H, PAGE_W } from '../domain/types';
import { checkAnswer, mapPoint, sampleQuestions, withDatum, withFinalDepth, withLocation } from './clarifications';
import { crsCandidatesFor, EQ_DOC_ID, EQ_FILE, FIRST_GENERATED_PAGE, REPORT_TITLES, sampleDocuments, type PrintedIds } from './documents';
import { generateBorehole, makeSeeds, type Placement, type Seed } from './generate';
import { genericPage, pageMap } from './helpers';
import { bk07, bk07Sheet, BK07_PAGES, NB_DOC_ID, NB_FILE } from './neckarbogen';
import { featuresOf, isLocated, runResultSet, searchPlaces, toFeature } from './query';

/** Simulated transfer of one upload (ms), reported in UPLOAD_TICKS progress steps. */
export const SAMPLE_UPLOAD_MS = 1000;
const UPLOAD_TICKS = 4;
/** Simulated processing timings, as in the prototype (ms after the upload was accepted). */
const STEP1_MS = 1800;
const STEP2_MS = 5200;

/** What the sample "server" reports at boot: fictional data, no providers. */
const SAMPLE_HEALTH: Health = {
  mode: 'sample',
  status: 'ok',
  version: 'sample',
  providers: { ocr: false, classifier: false, extractor: false, chat: false, geocoder: false },
  upload: { maxMb: 200, extensions: ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.docx', '.xlsx', '.csv'] },
  auth: { enabled: false, registration: 'closed' },
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
 * and the position from the candidate's point (which puts it on the map). A candidate that contradicts
 * the AI's guess marks the value as Edited. No revision change here: the caller bumps it once.
 */
function withCrs(b: Borehole, c: CrsCandidate): Borehole {
  const point = c.points.find((p) => p.uid === b.uid);
  return {
    ...b,
    ...(point ? { lat: point.lat, lng: point.lng, onMap: true, unplottedReason: null } : {}),
    crs: { name: c.name, code: c.code, status: 'confirmed' },
    values: b.values.map((v) =>
      v.key === K.crs
        ? { ...v, value: c.name, status: 'approved', state: 'ok', method: c.verdict === 'match' ? v.method : 'Edited' }
        : v,
    ),
  };
}

/** True when a borehole has printed coordinates a coordinate system can place. */
const hasLocalPoint = (b: Borehole) => b.meta.localX != null && b.meta.localY != null;

/** A question counts against its boreholes and document until it is answered (open or skipped). */
const unresolved = (q: Clarification) => q.status !== 'answered';

/** Oldest first, like GET /clarifications. */
const byCreation = (a: Clarification, b: Clarification) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

/** The 422 of an answer that doesn't fit the question's form. */
const ANSWER_INVALID = "The answer does not match the question's fields.";

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
  /** The subscribers' event handlers. */
  const listeners = new Set<(event: LiveEvent) => void>();
  let uploads = 0;
  /** The clarification questions by id; the open-question counts below follow them. */
  const questions = new Map(sampleQuestions(boreholes, candidatesOf(NB_DOC_ID)).map((q) => [q.id, q]));
  /** Stored result sets by id (`rs_` and a counter). */
  const resultSets = new Map<string, ResultSet>();
  let resultSetCount = 0;

  /** Tells every subscriber, each with its own copy. */
  const emit = (event: LiveEvent) => {
    for (const listener of [...listeners]) listener(structuredClone(event));
  };

  /**
   * Brings every open-question count in line with the questions: a borehole or document counts the
   * unresolved (open or skipped) questions that name it. No revision change here.
   */
  function recount(): void {
    const ofBorehole = new Map<string, number>();
    const ofDoc = new Map<string, number>();
    for (const q of questions.values()) {
      if (!unresolved(q)) continue;
      for (const uid of q.boreholeUids) ofBorehole.set(uid, (ofBorehole.get(uid) ?? 0) + 1);
      ofDoc.set(q.documentId, (ofDoc.get(q.documentId) ?? 0) + 1);
    }
    for (const [uid, b] of byUid) {
      const n = ofBorehole.get(uid) ?? 0;
      if (b.openClarifications !== n) byUid.set(uid, { ...b, openClarifications: n });
    }
    docs = docs.map((d) => {
      const n = ofDoc.get(d.id) ?? 0;
      return d.openClarifications === n ? d : { ...d, openClarifications: n };
    });
  }
  recount();

  /**
   * One change of the sample "server": `change` replaces boreholes (without revision changes) and may
   * resolve a question, which it returns. Then the counts follow the questions, every changed borehole
   * gets the next revision once (its review status derived like the backend's), and the subscribers
   * hear of it as in API mode: clarification.resolved, borehole.updated per changed borehole and
   * document.updated per changed queue document.
   */
  function commit(change: () => Clarification | null): void {
    const before = new Map(byUid);
    const docsBefore = new Map(docs.map((d) => [d.id, d]));
    const resolved = change();
    recount();
    const changed: Borehole[] = [];
    for (const [uid, b] of byUid) {
      if (before.get(uid) === b) continue;
      const next = revised(b);
      byUid.set(uid, next);
      changed.push(next);
    }
    if (resolved && resolved.status !== 'open') emit({ type: 'clarification.resolved', clarificationId: resolved.id, status: resolved.status });
    for (const b of changed) emit({ type: 'borehole.updated', uid: b.uid, revision: b.revision });
    for (const d of docs) if (docsBefore.get(d.id) !== d) emit({ type: 'document.updated', document: d });
  }

  /** Marks a question answered (who answered is stored only when given, never invented). */
  function markAnswered(q: Clarification, values: Record<string, unknown>, by: string | null): Clarification {
    const name = by?.trim() ? by.trim().slice(0, 100) : null;
    const next: Clarification = { ...q, status: 'answered', answer: structuredClone(values), answeredBy: name, resolvedAt: new Date().toISOString() };
    questions.set(q.id, next);
    return next;
  }

  /** A candidate of a document that can place its boreholes, else the backend's crs_invalid. */
  function placingCandidate(documentId: string, code: string, swapAxes: boolean): CrsCandidate {
    const c = candidatesOf(documentId).find((x) => x.code === code && x.swapAxes === swapAxes);
    if (!c || c.verdict === 'out_of_range') {
      throw new ApiError(422, 'crs_invalid', `${code}${swapAxes ? ' with swapped axes' : ''} cannot place the boreholes of this document.`);
    }
    return c;
  }

  /**
   * What an accepted answer changes, where the effect is simple (the backend's kinds with a direct
   * record change): a CRS for the question's boreholes with printed coordinates, the datum, the chosen
   * reading of the final depth, a position placed on the map. Other kinds only store the answer.
   * Throws (nothing changed) when the answer can't be applied.
   */
  function effectOf(q: Clarification, v: Record<string, unknown>): () => void {
    const each = (fn: (b: Borehole) => Borehole) => () => {
      for (const uid of q.boreholeUids) {
        const b = byUid.get(uid);
        if (b) byUid.set(uid, fn(b));
      }
    };
    switch (q.kind) {
      case 'crs_confirm': {
        if (typeof v.crs !== 'string') return () => undefined;
        const c = placingCandidate(q.documentId, v.crs, v.swap_axes === true);
        return each((b) => (hasLocalPoint(b) ? withCrs(b, c) : b));
      }
      case 'datum_convention': {
        const datum = v.datum;
        return typeof datum === 'string' ? each((b) => withDatum(b, datum)) : () => undefined;
      }
      case 'choose_reading': {
        const reading = q.fields.find((f) => f.widget === 'choose_reading');
        const value = reading ? v[reading.name] : undefined;
        return q.path === 'metadata.borehole_depth_m' && typeof value === 'number' ? each((b) => withFinalDepth(b, value)) : () => undefined;
      }
      case 'locate_borehole': {
        const point = Object.values(v).map(mapPoint).find((p) => p != null);
        return point ? each((b) => withLocation(b, point)) : () => undefined;
      }
      default:
        return () => undefined;
    }
  }

  /**
   * The simulated server accepts an uploaded file: a new document in classification, which reaches
   * extraction after STEP1_MS and review after STEP2_MS, each step announced as document.updated.
   */
  const accept = (file: File, project: string | null): DocumentSummary => {
    uploads += 1;
    const id = `u${Date.now()}${uploads}`;
    const n = 8 + (file.name.length % 14);
    const set = (patch: Partial<DocumentSummary>) => {
      docs = docs.map((d) => (d.id === id ? { ...d, ...patch } : d));
      const doc = docs.find((d) => d.id === id);
      if (!doc) return;
      for (const listener of [...listeners]) listener({ type: 'document.updated', document: structuredClone(doc) });
    };
    const opts = { language: 'de', handwriting: 'none' as const };
    const first: DocumentSummary = {
      id, name: file.name, project: project ?? '', status: 'classifying',
      pages: pageMap('CT' + '?'.repeat(n - 2), opts),
      step: 0, progress: { pagesTotal: n, pagesClassified: 2, pagesOcrTotal: 0, pagesOcrDone: 0, boreholesExtracted: 0 },
      counts: null, completeness: null, reviewBoreholeUid: null, openClarifications: 0, duplicateOf: null, error: null,
      uploaded: true, simulated: true,
    };
    docs = [first, ...docs];
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
    return structuredClone(first);
  };

  return {
    kind: 'sample',

    async health() {
      return structuredClone(SAMPLE_HEALTH);
    },

    async load() {
      const all = [...byUid.values()];
      return structuredClone({ documents: docs, features: featuresOf(all), unplotted: all.filter((b) => !b.onMap) });
    },

    async mapFeatures(documentId) {
      const all = [...byUid.values()];
      return structuredClone(featuresOf(documentId ? all.filter((b) => b.documentId === documentId) : all));
    },

    async unplotted() {
      return structuredClone([...byUid.values()].filter((b) => !b.onMap));
    },

    async createResultSet(filter) {
      if (filter.area?.type === 'circle' && !(filter.area.radiusM > 0)) {
        throw new ApiError(422, 'validation_error', 'Request validation failed.', [{ loc: ['body', 'area', 'radius_m'], msg: 'Input should be greater than 0' }]);
      }
      resultSetCount += 1;
      const rs = runResultSet([...byUid.values()], filter, `rs_${resultSetCount}`, new Date().toISOString());
      resultSets.set(rs.id, rs);
      return structuredClone(rs);
    },

    async getResultSet(id) {
      const rs = resultSets.get(id);
      if (!rs) throw new ApiError(404, 'result_set_not_found', 'Result set not found or expired.');
      return structuredClone(rs);
    },

    async resultSetFeatures(id) {
      const rs = resultSets.get(id);
      if (!rs) throw new ApiError(404, 'result_set_not_found', 'Result set not found or expired.');
      // The members as they are now; only placed ones are features (the set counts the others).
      const members = rs.uids.map((uid) => byUid.get(uid)).filter((b): b is Borehole => b != null && isLocated(b));
      return structuredClone(members.map(toFeature));
    },

    async geocode(query) {
      if (query.trim().length < 2) {
        throw new ApiError(422, 'validation_error', 'Request validation failed.', [{ loc: ['query', 'q'], msg: 'String should have at least 2 characters' }]);
      }
      return structuredClone(searchPlaces([...byUid.values()], query));
    },

    async clarifications(options = {}) {
      const status = options.status ?? 'open';
      const list = [...questions.values()].filter((q) => q.status === status && (!options.documentId || q.documentId === options.documentId));
      return structuredClone(list.sort(byCreation));
    },

    async answerClarification(id, values, answeredBy) {
      const q = questions.get(id);
      if (!q) throw new ApiError(404, 'clarification_not_found', 'Clarification not found.');
      if (q.status === 'answered') throw new ApiError(409, 'already_resolved', 'This question has already been answered.');
      const { accepted, errors } = checkAnswer(q.fields, values ?? {});
      if (errors.length) throw new ApiError(422, 'answer_invalid', ANSWER_INVALID, errors);
      const effect = effectOf(q, accepted);
      let answered = q;
      commit(() => {
        effect();
        answered = markAnswered(q, accepted, answeredBy);
        return answered;
      });
      return structuredClone(answered);
    },

    async skipClarification(id) {
      const q = questions.get(id);
      if (!q) throw new ApiError(404, 'clarification_not_found', 'Clarification not found.');
      if (q.status === 'answered') throw new ApiError(409, 'already_resolved', 'This question has already been answered.');
      if (q.status === 'skipped') return structuredClone(q);
      const skipped: Clarification = { ...q, status: 'skipped' };
      // Still unresolved: the counts and the badges stay.
      commit(() => {
        questions.set(id, skipped);
        return skipped;
      });
      return structuredClone(skipped);
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

    async getPageWords(documentId, page) {
      // The drawn page's texts stand in for a text layer: one word per item, boxes in the 560×780 space.
      const content = await this.getPage(documentId, page);
      return (content.items ?? []).flatMap((it) => {
        if (it.kind !== 'text' || !it.text?.trim()) return [];
        const size = it.fontSize ?? 12;
        const w = Math.min(it.w ?? it.text.length * size * 0.6, PAGE_W - it.x);
        return [{ text: it.text, box: { x: it.x / PAGE_W, y: it.y / PAGE_H, w: w / PAGE_W, h: (size * 1.2) / PAGE_H }, conf: 1, source: 'text' as const }];
      });
    },

    thumbnailUrl() {
      // Sample pages are drawn, not served as images.
      return null;
    },

    upload(file, { project, onProgress }) {
      let answered = false;
      let settle!: { resolve: (r: UploadResult) => void; reject: (e: unknown) => void };
      const done = new Promise<UploadResult>((resolve, reject) => {
        settle = { resolve, reject };
      });
      const total = file.size;
      const ticks = Array.from({ length: UPLOAD_TICKS }, (_, i) =>
        setTimeout(() => {
          onProgress?.({ loaded: Math.round((total * (i + 1)) / UPLOAD_TICKS), total });
          if (i < UPLOAD_TICKS - 1) return;
          answered = true;
          settle.resolve({ document: accept(file, project), duplicate: false });
        }, ((i + 1) * SAMPLE_UPLOAD_MS) / UPLOAD_TICKS),
      );
      return {
        done,
        cancel() {
          if (answered) return;
          answered = true;
          for (const t of ticks) clearTimeout(t);
          settle.reject(new UploadCancelledError(file.name));
        },
      };
    },

    subscribe(onEvent, onStatus) {
      listeners.add(onEvent);
      onStatus('live');
      return () => {
        listeners.delete(onEvent);
      };
    },

    follow() {
      // The simulated documents announce every step themselves.
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

    async confirmCrs(documentId, { code, swapAxes, confirmedBy }) {
      const c = placingCandidate(documentId, code, swapAxes);
      // Like the backend, only boreholes with printed coordinates get the system; the count says how many.
      const targets = ofDocument(documentId).filter(hasLocalPoint);
      commit(() => {
        for (const b of targets) byUid.set(b.uid, withCrs(b, c));
        // The sample also answers the report's open CRS question with it (the prototype's behaviour).
        const q = [...questions.values()].find((x) => x.kind === 'crs_confirm' && x.documentId === documentId && unresolved(x));
        return q ? markAnswered(q, { crs: code, swap_axes: swapAxes }, confirmedBy) : null;
      });
      return targets.length;
    },

    // The sample has no sign-in (health.auth.enabled is false); nothing calls these.
    async currentUser() {
      return null;
    },
    async signIn() {
      throw new Error('The sample has no sign-in');
    },
    async register() {
      throw new Error('The sample has no sign-in');
    },
    async signOut() {},
    setSessionListener() {},
  };
}
