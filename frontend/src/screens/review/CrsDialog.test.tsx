/** F13: the CRS dialog on the backend's candidates, server-rendered (fictional candidates; maps are not drawn here). */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCandidate, makeClarification } from '../../components/clarify/clarifyFixtures';
import { resetTestStore } from '../../components/clarify/testStore';
import { makeBorehole } from '../../test/fixtures';
import { CrsDialog } from './CrsDialog';

vi.mock('leaflet', () => ({}));
vi.mock('../../store/appStore', async (importOriginal) => (await import('../../components/clarify/testStore')).mockAppStore(await importOriginal()));

const B = makeBorehole({ uid: 'bh_01TESTCRS0000000000000001', id: 'BH-1', documentId: 'doc_01TESTCRS' });
const CANDIDATES = [
  makeCandidate({ code: 'EPSG:0001', name: 'Fictional Grid A', verdict: 'match', score: 1, note: '1 of 1 points inside the area of use' }),
  makeCandidate({ code: 'EPSG:0001', name: 'Fictional Grid A', verdict: 'match', score: 0.935, swapAxes: true, note: 'printed X read as northing' }),
  makeCandidate({ code: 'EPSG:0002', name: 'Fictional Grid B', verdict: 'shifted', score: 0.365, note: 'centroid 8611 km from the place' }),
  makeCandidate({ code: 'EPSG:0003', name: 'Fictional Grid C', verdict: 'out_of_range', score: 0, points: [] }),
  makeCandidate({ code: 'EPSG:0004', name: 'Fictional Grid D', verdict: null }),
];

function render(o: { pick?: number; questions?: ReturnType<typeof makeClarification>[] } = {}) {
  resetTestStore({
    boreholes: [B],
    reviewUid: B.uid,
    crsCandidates: CANDIDATES,
    crsPick: o.pick ?? 0,
    crsLoading: false,
    clarificationsState: 'ready',
    clarifications: o.questions ?? [],
  });
  return renderToStaticMarkup(<CrsDialog />);
}

const radios = (html: string) => html.match(/<button[^>]*role="radio"[^>]*>.*?<\/button>/g) ?? [];

beforeEach(() => resetTestStore());

describe('CrsDialog', () => {
  it('lists every candidate with the backend’s label, code, score, verdict and note; the picked one is checked', () => {
    const r = radios(render());
    expect(r).toHaveLength(5);
    expect(r[0]).toContain('aria-checked="true"');
    expect(r[0]).toContain('Fictional Grid A');
    expect(r[0]).toContain('EPSG:0001 · score 1.00');
    expect(r[0]).toContain('pins on site · 1 of 1 points inside the area of use');
    expect(r[2]).toContain('shifted from the site · centroid 8611 km from the place');
    expect(r[3]).toContain('out of range');
  });

  it('colours each candidate by its verdict; no verdict stays neutral', () => {
    const r = radios(render());
    expect(r.map((x) => /data-verdict="([^"]+)"/.exec(x)?.[1])).toEqual(['match', 'match', 'shifted', 'out_of_range', 'none']);
    expect(r[0]).toContain('border-left-color:#7DB713');
    expect(r[2]).toContain('border-left-color:#E39B00');
    expect(r[3]).toContain('border-left-color:#C8102E');
    expect(r[4]).toContain('border-left-color:#A3A3A2');
    expect(r[4]).toContain('No verdict from the backend');
  });

  it('marks the candidate that reads the printed X as the northing', () => {
    const r = radios(render());
    expect(r[1]).toContain('⇄ X / Y swapped');
    expect(r[0]).not.toContain('swapped');
  });

  it('shows a mini-map beside every candidate, and the picked one large', () => {
    const html = render();
    expect(html.match(/<div class="[^"]*previewMap[^"]*" aria-hidden="true"/g)).toHaveLength(5);
    // The out-of-range candidate has no pins and says so.
    expect(html).toContain('Out of range: no pins');
    expect(html).toContain('aria-label="Map preview of the picked CRS"');
  });

  it('confirms for the whole document; an out-of-range pick can’t be confirmed', () => {
    expect(render().match(/<button[^>]*>CONFIRM FOR WHOLE DOCUMENT<\/button>/)?.[0]).not.toContain('disabled');
    const out = render({ pick: 3 });
    expect(out.match(/<button[^>]*>CONFIRM FOR WHOLE DOCUMENT<\/button>/)?.[0]).toContain('disabled=""');
    expect(out).toContain('Coordinates out of range: no pins can be placed');
  });

  it('offers to answer the open CRS question instead when one covers the document', () => {
    expect(render()).not.toContain('Answer it for the whole project instead');
    const q = makeClarification({ id: 'cl_crs', kind: 'crs_confirm', documentId: 'doc_01TESTOTHER', boreholeUids: [B.uid, 'bh_other'] });
    const html = render({ questions: [q] });
    expect(html).toContain('An open question asks for this coordinate system (2 boreholes, possibly in other reports of the project).');
    expect(html).toContain('>Answer it for the whole project instead</button>');
    // An answered question no longer counts.
    expect(render({ questions: [{ ...q, status: 'answered' }] })).not.toContain('Answer it for the whole project instead');
  });

  it('opened from a queue card: it is about that document, without a review borehole', () => {
    const other = makeBorehole({ uid: 'bh_01TESTCRS0000000000000009', id: 'XY-9', documentId: 'doc_01TESTOTHERDOC' });
    resetTestStore({
      boreholes: [other, B],
      reviewUid: other.uid,
      crsDocumentId: B.documentId,
      crsCandidates: CANDIDATES,
      crsPick: 0,
      crsLoading: false,
      clarificationsState: 'ready',
      clarifications: [makeClarification({ id: 'cl_crs', kind: 'crs_confirm', documentId: B.documentId!, boreholeUids: [B.uid] })],
    });
    const html = renderToStaticMarkup(<CrsDialog />);
    expect(html).toContain('CONFIRM CRS FOR THE WHOLE DOCUMENT');
    // The question of that document (not of the review borehole's) is offered.
    expect(html).toContain('An open question asks for this coordinate system (1 borehole, possibly in other reports of the project).');
  });
});
