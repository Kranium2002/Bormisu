import { describe, expect, it } from 'vitest';
import { makeMeta } from '../test/fixtures';
import { decimal, decimalComma, lintText, metres, parseNumber, printedCoordinates, unplottedText } from './format';

describe('unplottedText', () => {
  it('labels the backend reason codes and makes no reason up', () => {
    expect(unplottedText({ unplottedReason: 'no_coordinates' })).toBe('No coordinates in source');
    expect(unplottedText({ unplottedReason: 'crs_unknown' })).toBe('Coordinate system unknown');
    expect(unplottedText({ unplottedReason: 'crs_unconfirmed' })).toBe('Coordinate system needs confirmation');
    expect(unplottedText({ unplottedReason: 'implausible' })).toBe('Coordinates implausible');
    expect(unplottedText({ unplottedReason: null })).toBe('Not placed on the map');
  });
});

describe('printedCoordinates', () => {
  it('joins X and Y as printed, with the axis labels', () => {
    expect(printedCoordinates(makeMeta({ xRaw: '512 000', yRaw: '5 540 000', axisLabelsRaw: 'E / N' }))).toBe('512 000 / 5 540 000 (E / N)');
    expect(printedCoordinates(makeMeta({ xRaw: '512 000', yRaw: null }))).toBe('512 000');
    expect(printedCoordinates(makeMeta())).toBe('');
  });
});

describe('decimalComma', () => {
  it('prints decimals with a comma', () => {
    expect(decimalComma(18)).toBe('18,00');
    expect(decimalComma(0.4)).toBe('0,40');
    expect(decimalComma(241.354, 1)).toBe('241,4');
  });
});

describe('decimal', () => {
  it('prints decimals with the app’s decimal point (uiv-B8)', () => {
    expect(decimal(18)).toBe('18.00');
    expect(decimal(241.354, 1)).toBe('241.4');
  });
});

describe('lintText', () => {
  it('marks a lint the app added itself', () => {
    expect(lintText({ severity: 'error', message: 'Refusal with N' })).toBe('Refusal with N');
    expect(lintText({ severity: 'error', message: 'Increments 4 + 5 = 9 ≠ N 8', client: true })).toBe(
      'Increments 4 + 5 = 9 ≠ N 8 (checked by the app, not the backend)',
    );
  });
});

describe('metres', () => {
  it('formats depths, and null as blank (never 0)', () => {
    expect(metres(11.2)).toBe('11.20 m');
    expect(metres(null)).toBe('');
    expect(metres(undefined)).toBe('');
  });
});

describe('parseNumber', () => {
  it('parses dot, comma and space-grouped numbers', () => {
    expect(parseNumber('18.00')).toBe(18);
    expect(parseNumber('18,50')).toBe(18.5);
    expect(parseNumber('3 513 420')).toBe(3513420);
    expect(parseNumber('-2.5')).toBe(-2.5);
  });

  it('rejects text', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('N = 8')).toBeNull();
    expect(parseNumber('18,00 m')).toBeNull();
  });
});
