/** F13: how a CRS candidate is shown (fictional candidates only). */
import { describe, expect, it } from 'vitest';
import { COL } from '../../theme';
import { makeCandidate } from './clarifyFixtures';
import { plottablePoints, scoreText, verdictColor, verdictText } from './crsView';

describe('crsView', () => {
  it('colours by verdict; no verdict stays neutral', () => {
    expect(verdictColor('match')).toBe(COL.green);
    expect(verdictColor('shifted')).toBe(COL.amber);
    expect(verdictColor('out_of_range')).toBe(COL.red);
    expect(verdictColor(null)).toBe(COL.grey);
  });

  it('shows the backend’s verdict and note, or says it sent none', () => {
    expect(verdictText({ verdict: 'match', note: '1 of 1 points inside the area of use' })).toBe('pins on site · 1 of 1 points inside the area of use');
    expect(verdictText({ verdict: 'shifted', note: null })).toBe('shifted from the site');
    expect(verdictText({ verdict: null, note: 'only a note' })).toBe('only a note');
    expect(verdictText({ verdict: null, note: null })).toBe('No verdict from the backend');
  });

  it('a score only when the backend sent one', () => {
    expect(scoreText({ score: 0.935 })).toBe('score 0.94');
    expect(scoreText({ score: null })).toBe('');
  });

  it('maps only points on the globe, and none of an out-of-range candidate', () => {
    const c = makeCandidate({
      code: 'EPSG:0001',
      verdict: 'match',
      points: [
        { uid: 'a', lat: 10, lng: 20 },
        { uid: 'b', lat: 95, lng: 20 },
        { uid: 'c', lat: 10, lng: Number.NaN },
      ],
    });
    expect(plottablePoints(c).map((p) => p.uid)).toEqual(['a']);
    expect(plottablePoints({ ...c, verdict: 'out_of_range' })).toEqual([]);
  });
});
