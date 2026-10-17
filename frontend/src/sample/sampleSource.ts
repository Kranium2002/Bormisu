// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.
/** DataSource over the fictional sample: in-memory, mutations persist for the session, simulated uploads. */
import { applyValuePatch, confirmCrsOn } from '../domain/review';
import type { Borehole, CrsCandidate, DocumentSummary, PageContent, PageItem, PageType } from '../domain/types';
import type { DataSource } from '../data/DataSource';
import { pageUsage } from '../theme';
import { crsCandidatesFor, EQ_DOC_ID, EQ_FILE, FIRST_GENERATED_PAGE, REPORT_TITLES, sampleDocuments } from './documents';
import { generateBorehole, makeSeeds, type Placement, type Seed } from './generate';
import { genericPage } from './helpers';
import { bk07, bk07Sheet, BK07_PAGES, NB_DOC_ID, NB_FILE, NB_SITE } from './neckarbogen';

/** Simulated upload timings, as in the prototype (ms after the drop). */
const STEP1_MS = 1800;
const STEP2_MS = 5200;

interface DrawnPage { items: PageItem[]; label: string; type: PageType }

/** Where a seed's log lives: Neckarbogen and Elbquerung in their queue documents, the rest in archive files. */
function placementOf(seed: Seed, rank: number): Placement {
  if (seed.nb) return { documentId: NB_DOC_ID, file: NB_FILE, page: FIRST_GENERATED_PAGE[NB_DOC_ID] + rank };
  if (seed.project === 'Elbquerung Ost') return { documentId: EQ_DOC_ID, file: EQ_FILE, page: FIRST_GENERATED_PAGE[EQ_DOC_ID] + rank };
  const slug = seed.project.toLowerCase().replace(/[^a-z]+/g, '_');
  return { documentId: slug, file: `${slug}_bohrprofile.pdf`, page: 1 + rank };
}

/** Builds every sample borehole (in prototype order) and the log pages drawn for them. */
function buildSample(): { boreholes: Borehole[]; drawn: Map<string, DrawnPage> } {
  const drawn = new Map<string, DrawnPage>();
  for (const p of BK07_PAGES) {
    drawn.set(`${NB_DOC_ID}:${p}`, { items: bk07Sheet(p), label: `page ${p} · sheet ${p - 6} of 2 · ${NB_FILE}`, type: 'log' });
  }
  const ranks = new Map<string, number>();
  const boreholes = makeSeeds().map((seed) => {
    if (seed.id === 'BK-07') return bk07(seed.lat, seed.lng);
    const rank = ranks.get(seed.project) ?? 0;
    ranks.set(seed.project, rank + 1);
    const at = placementOf(seed, rank);
    const { borehole, items } = generateBorehole(seed, at);
    drawn.set(`${at.documentId}:${at.page}`, { items, label: `page ${at.page} · ${at.file}`, type: 'log' });
    return borehole;
  });
  return { boreholes, drawn };
}

/** Creates the in-memory sample data source. */
export function createSampleSource(): DataSource {
  const { boreholes, drawn } = buildSample();
  const byUid = new Map(boreholes.map((b) => [b.uid, b]));
  const candidates = new Map<string, CrsCandidate[]>();
  let docs = sampleDocuments();

  const candidatesOf = (documentId: string) => {
    if (!candidates.has(documentId)) candidates.set(documentId, crsCandidatesFor(documentId, boreholes));
    return candidates.get(documentId) as CrsCandidate[];
  };

  return {
    kind: 'sample',
    simulatedSite: { ...NB_SITE },

    async load() {
      return structuredClone({ boreholes: [...byUid.values()], documents: docs });
    },

    async getPage(documentId, page): Promise<PageContent> {
      const own = drawn.get(`${documentId}:${page}`);
      if (own) return { documentId, page, type: own.type, usage: pageUsage(own.type, page), label: own.label, items: own.items };
      const doc = docs.find((d) => d.id === documentId);
      const type = doc?.pageTypes[page - 1];
      if (!doc || !type) throw new Error(`Page ${page} of document ${documentId} not found`);
      const title = REPORT_TITLES[documentId] ?? { project: doc.project, date: '' };
      return {
        documentId, page, type, usage: pageUsage(type, page), label: `page ${page} · ${doc.name}`,
        items: genericPage(page, type, title),
      };
    },

    async upload(files, onUpdate) {
      files.forEach((f, k) => {
        const id = `u${Date.now()}${k}`;
        const n = 8 + (f.name.length % 14);
        const types = (fn: (i: number) => PageType) => Array.from({ length: n }, (_, i) => fn(i));
        const set = (patch: Partial<DocumentSummary>) => {
          docs = docs.map((d) => (d.id === id ? { ...d, ...patch } : d));
          const doc = docs.find((d) => d.id === id);
          if (doc) onUpdate(structuredClone(doc));
        };
        const first: DocumentSummary = {
          id, name: f.name, project: 'New upload', pageTypes: types((i) => (i < 2 ? 'text' : 'unknown')),
          step: 0, counts: null, completeness: null, reviewBoreholeUid: null, uploaded: true, simulated: true,
        };
        docs = [first, ...docs];
        onUpdate(structuredClone(first));
        setTimeout(() => set({ step: 1, pageTypes: types((i) => (i < 2 ? 'text' : i < n / 2 ? 'log' : 'unknown')) }), STEP1_MS);
        setTimeout(
          () =>
            set({
              step: 2,
              pageTypes: types((i) => (i < 2 ? 'text' : i === n - 1 ? 'photo' : i > n - 4 ? 'lab_table' : 'log')),
              counts: { boreholes: Math.max(1, n - 9), layers: (n - 6) * 4, spt: n - 4, groundwater: Math.max(0, n - 10) },
              completeness: { listed: Math.max(1, n - 9), idPrefix: 'NEW-', missing: [], unexpected: [], lint: [] },
            }),
          STEP2_MS,
        );
      });
    },

    async updateValue(uid, key, patch) {
      const b = byUid.get(uid);
      if (!b) throw new Error(`Borehole ${uid} not found`);
      byUid.set(uid, applyValuePatch(b, key, patch));
    },

    async crsCandidates(documentId) {
      return structuredClone(candidatesOf(documentId));
    },

    async confirmCrs(documentId, code) {
      const c = candidatesOf(documentId).find((x) => x.code === code);
      if (!c || c.verdict === 'out_of_range') throw new Error(`${code} cannot place the boreholes of this document`);
      for (const b of byUid.values()) {
        if (b.documentId === documentId) byUid.set(b.uid, confirmCrsOn(b, c));
      }
    },
  };
}
