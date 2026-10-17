import { describe, expect, it } from 'vitest';
import { formatSpt, parseSptText, refusalText, refusalTitle, sptLint } from './spt';

describe('sptLint', () => {
  it('flags increments that do not add up to N', () => {
    expect(sptLint({ raw: '3,4,5 = 8', depth: 1.5, refusal: false, increments: [3, 4, 5], n: 8 })).toEqual({
      severity: 'error',
      message: 'Increments 4 + 5 = 9 ≠ N 8',
    });
  });

  it('accepts consistent increments', () => {
    expect(sptLint({ raw: '4,5,5 = 10', depth: 3.5, refusal: false, increments: [4, 5, 5], n: 10 })).toBeUndefined();
  });

  it('never lints a refusal or an SPT without increments', () => {
    expect(sptLint({ raw: '50/30', depth: 10.5, refusal: true, blows: 50, penetrationCm: 30 })).toBeUndefined();
    expect(sptLint({ raw: 'N = 12', depth: 2, refusal: false, n: 12 })).toBeUndefined();
  });
});

describe('formatSpt', () => {
  it('formats N and refusals, never N = 50 for a refusal', () => {
    expect(formatSpt({ raw: '2,3,4 = 7', depth: 6, refusal: false, increments: [2, 3, 4], n: 7 })).toBe('N = 7');
    expect(formatSpt({ raw: '50/30', depth: 10.5, refusal: true, blows: 50, penetrationCm: 30 })).toBe(
      'refusal · 50 blows / 30 cm',
    );
    expect(formatSpt({ raw: '50/?', depth: 1, refusal: true })).toBe('refusal · 50/?');
  });
});

describe('refusalTitle', () => {
  it('explains the raw refusal string', () => {
    expect(refusalTitle({ raw: '50/30', depth: 10.5, refusal: true, blows: 50, penetrationCm: 30 })).toBe(
      'Raw “50/30”: 50 blows for 30 cm penetration. Not N = 50.',
    );
  });
});

describe('parseSptText', () => {
  const prev = { raw: '3,4,5 = 8', depth: 1.5, refusal: false, increments: [3, 4, 5], n: 8 };

  it('reads N values and refusals the way the review list shows them', () => {
    expect(parseSptText('N = 9', prev)).toEqual({ raw: '3,4,5 = 8', depth: 1.5, refusal: false, increments: [3, 4, 5], n: 9 });
    expect(parseSptText('9', prev)?.n).toBe(9);
    expect(parseSptText('50/30', prev)).toMatchObject({ refusal: true, blows: 50, penetrationCm: 30 });
    expect(parseSptText('refusal · 50 blows / 12 cm', prev)).toMatchObject({ refusal: true, blows: 50, penetrationCm: 12 });
    expect(parseSptText('see note', prev)).toBeNull();
  });

  it('formats an edited refusal for the export', () => {
    expect(refusalText({ raw: 'x', depth: 1, refusal: true, blows: 50, penetrationCm: 30 }, 'fallback')).toBe('50/30');
    expect(refusalText({ raw: 'x', depth: 1, refusal: true }, 'refusal')).toBe('refusal');
  });
});
