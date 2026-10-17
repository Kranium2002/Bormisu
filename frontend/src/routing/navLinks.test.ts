/** F4: targets of the MAP and REVIEW header links (fictional uids). */
import { describe, expect, it } from 'vitest';
import { mapHref, reviewHref, reviewOffReason, reviewTarget } from './navLinks';

const A = 'bh_A';
const B = 'bh_B';
const loaded = [{ uid: A }, { uid: B }];

describe('reviewTarget / reviewHref', () => {
  it('the last reviewed borehole, with its focused value', () => {
    const s = { reviewUid: B, focusKey: 'layer[1].spt', boreholes: loaded, documents: [{ reviewBoreholeUid: A }] };
    expect(reviewTarget(s)).toBe(B);
    expect(reviewHref(s)).toBe(`/review/${B}?key=layer%5B1%5D.spt`);
  });

  it('else the first document in review that has a loaded borehole', () => {
    const s = { reviewUid: null, focusKey: null, boreholes: loaded, documents: [{ reviewBoreholeUid: null }, { reviewBoreholeUid: 'bh_gone' }, { reviewBoreholeUid: A }] };
    expect(reviewHref(s)).toBe(`/review/${A}`);
  });

  it('a last reviewed borehole that is no longer loaded falls back to the documents, without its key', () => {
    const s = { reviewUid: 'bh_gone', focusKey: 'BoreholeDepth', boreholes: loaded, documents: [{ reviewBoreholeUid: A }] };
    expect(reviewHref(s)).toBe(`/review/${A}`);
  });

  it('none: null, and the link says why it is off', () => {
    expect(reviewHref({ reviewUid: null, focusKey: null, boreholes: [], documents: [] })).toBeNull();
    expect(reviewOffReason('ready')).toBe('No report is ready for review yet. Upload one under UPLOAD & QUEUE.');
    expect(reviewOffReason('loading')).toBe('Loading boreholes and documents…');
    expect(reviewOffReason('error')).toBe('Nothing is loaded');
  });
});

describe('mapHref', () => {
  it('returns to the last view and result set, without a selected pin', () => {
    expect(mapHref({ mapView: null, resultSetId: null })).toBe('/map');
    expect(mapHref({ mapView: { lat: -41.29, lng: 174.78, zoom: 11.5 }, resultSetId: 'rs_1' })).toBe('/map?at=-41.29,174.78,11.5&rs=rs_1');
  });
});
