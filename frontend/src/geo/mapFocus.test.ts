import { describe, expect, it } from 'vitest';
import { initialMapFocus, parseMapFocus, withFocusParam } from './mapFocus';

describe('parseMapFocus', () => {
  it('accepts world (any case) and two-letter codes (upper-cased); anything else is null', () => {
    expect(parseMapFocus('world')).toBe('world');
    expect(parseMapFocus(' World ')).toBe('world');
    expect(parseMapFocus('DE')).toBe('DE');
    expect(parseMapFocus('de')).toBe('DE');
    expect(parseMapFocus('sg')).toBe('SG');
    expect(parseMapFocus(undefined)).toBeNull();
    expect(parseMapFocus(null)).toBeNull();
    expect(parseMapFocus('')).toBeNull();
    expect(parseMapFocus('DEU')).toBeNull();
    expect(parseMapFocus('Germany')).toBeNull();
    expect(parseMapFocus('1A')).toBeNull();
  });
});

describe('initialMapFocus', () => {
  it('the URL parameter wins, then VITE_MAP_FOCUS, then world', () => {
    expect(initialMapFocus('?focus=de', 'NO')).toBe('DE');
    expect(initialMapFocus('?focus=world', 'DE')).toBe('world');
    expect(initialMapFocus('', 'DE')).toBe('DE');
    expect(initialMapFocus('?other=1', undefined)).toBe('world');
    expect(initialMapFocus('', '')).toBe('world');
    // An invalid parameter is ignored, not an error.
    expect(initialMapFocus('?focus=Germany', 'CH')).toBe('CH');
    expect(initialMapFocus('?focus=xyz', 'nonsense')).toBe('world');
  });
});

describe('withFocusParam', () => {
  it('sets or replaces the parameter and keeps the rest of the URL', () => {
    expect(withFocusParam('http://localhost:5173/', 'DE')).toBe('/?focus=DE');
    expect(withFocusParam('http://localhost:5173/app/?focus=DE&x=1#top', 'world')).toBe('/app/?focus=world&x=1#top');
  });
});
