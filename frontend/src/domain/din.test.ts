/** DIN 4023 lookup against the shared assets. Layers here are fictional. */
import { describe, expect, it } from 'vitest';
import { DIN_CODES, DIN_UNKNOWN_FILL, dinEntry, dinFill, dinLegendItems, dinNeedsUnderlay } from './din';

/** node:fs, typed here because the app tsconfig has no Node types (the tests run in Node >= 22.12). */
interface NodeHost { process: { getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL, encoding: 'utf8'): string } } }
const { readFileSync } = (globalThis as unknown as NodeHost).process.getBuiltinModule('node:fs');

/** patterns.svg as it lies on disk, read with node:fs instead of the bundler. */
const PATTERNS_SVG = readFileSync(new URL('../../../assets/din4023_patterns/patterns.svg', import.meta.url), 'utf8');

describe('dinEntry', () => {
  it('finds known codes with their English and German names', () => {
    expect(dinEntry('S')).toMatchObject({ code: 'S', kind: 'soil', nameEn: 'Sand', patternId: 'din-soil_S' });
    expect(dinEntry('Kst')).toMatchObject({ kind: 'rock', nameEn: 'Limestone', nameDe: 'Kalkstein', patternId: 'din-rock_Kst' });
    expect(dinEntry('Lö')?.patternId).toBe('din-geological_Loe');
  });

  it('is case-sensitive: mG is medium gravel, Mg is till marl', () => {
    expect(dinEntry('mG')?.nameEn).toBe('Medium gravel');
    expect(dinEntry('Mg')?.nameEn).toBe('Till marl');
    expect(dinEntry('MG')).toBeNull();
    expect(dinEntry('s')).toBeNull();
  });

  it('is null for unknown, missing and prototype keys', () => {
    expect(dinEntry('XYZ')).toBeNull();
    expect(dinEntry('')).toBeNull();
    expect(dinEntry(null)).toBeNull();
    expect(dinEntry(undefined)).toBeNull();
    expect(dinEntry('constructor')).toBeNull();
    expect(dinEntry('toString')).toBeNull();
  });
});

describe('dinFill', () => {
  it('fills a known code with its pattern', () => {
    expect(dinFill('T')).toBe('url(#din-soil_T)');
    expect(dinFill('Sst')).toBe('url(#din-rock_Sst)');
  });

  it('fills an unknown or missing code with plain #E0E0E0', () => {
    expect(DIN_UNKNOWN_FILL).toBe('#E0E0E0');
    expect(dinFill('XYZ')).toBe('#E0E0E0');
    expect(dinFill(null)).toBe('#E0E0E0');
    expect(dinFill(undefined)).toBe('#E0E0E0');
  });
});

describe('dinNeedsUnderlay', () => {
  it('is true only for A (fill), whose colour is null', () => {
    expect(dinEntry('A')?.colour).toBeNull();
    expect(dinNeedsUnderlay('A')).toBe(true);
    expect(DIN_CODES.filter(dinNeedsUnderlay)).toEqual(['A']);
    expect(dinNeedsUnderlay(null)).toBe(false);
    expect(dinNeedsUnderlay('XYZ')).toBe(false);
  });
});

describe('the asset set', () => {
  it('has 49 codes, each with a pattern in patterns.svg', () => {
    expect(DIN_CODES).toHaveLength(49);
    for (const code of DIN_CODES) {
      const id = dinEntry(code)?.patternId;
      expect(PATTERNS_SVG, `pattern of ${code}`).toContain(`<pattern id="${id}"`);
    }
  });

  it('only uses userSpaceOnUse patterns with the tile size of din_codes.json', () => {
    expect(PATTERNS_SVG).not.toContain('objectBoundingBox');
    for (const code of DIN_CODES) {
      const e = dinEntry(code)!;
      const tag = PATTERNS_SVG.match(new RegExp(`<pattern id="${e.patternId}"[^>]*>`))?.[0] ?? '';
      expect(tag).toContain('patternUnits="userSpaceOnUse"');
      expect(tag).toContain(`width="${e.tileWidth}"`);
      expect(tag).toContain(`height="${e.tileHeight}"`);
    }
  });
});

describe('dinLegendItems', () => {
  it('lists each code once from the top down, unknown codes included, missing codes left out', () => {
    const layers = [{ din: 'Mu' }, { din: 'A' }, { din: null }, { din: 'XYZ' }, { din: 'A' }, { din: 'mG' }];
    expect(dinLegendItems(layers).map((i) => i.code)).toEqual(['Mu', 'A', 'XYZ', 'mG']);
    expect(dinLegendItems(layers).find((i) => i.code === 'XYZ')?.entry).toBeNull();
    expect(dinLegendItems([])).toEqual([]);
  });
});
