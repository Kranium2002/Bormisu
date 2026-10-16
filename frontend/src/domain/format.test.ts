import { describe, expect, it } from 'vitest';
import { decimalComma, metres, parseNumber } from './format';

describe('decimalComma', () => {
  it('prints German decimals', () => {
    expect(decimalComma(18)).toBe('18,00');
    expect(decimalComma(0.4)).toBe('0,40');
    expect(decimalComma(241.354, 1)).toBe('241,4');
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
