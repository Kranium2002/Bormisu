import { describe, expect, it } from 'vitest';
import { FOCUS_REGION, focusRegion, GERMANY, inFocusRegion, MAP_FOCUS, outsideFocusReason, parseMapFocus } from './mapFocus';
import { distanceToRingsKm, pointInMultiPolygon } from './polygon';

describe('parseMapFocus', () => {
  it('defaults to DE; only "world" lifts the restriction', () => {
    expect(parseMapFocus(undefined)).toBe('DE');
    expect(parseMapFocus('')).toBe('DE');
    expect(parseMapFocus('DE')).toBe('DE');
    expect(parseMapFocus('de')).toBe('DE');
    expect(parseMapFocus('world')).toBe('world');
    expect(parseMapFocus(' World ')).toBe('world');
    expect(parseMapFocus('FR')).toBe('DE');
  });

  it('is DE in the unit tests (VITE_MAP_FOCUS unset)', () => {
    expect(MAP_FOCUS).toBe('DE');
    expect(FOCUS_REGION).toBe(GERMANY);
  });
});

describe('focusRegion', () => {
  it('DE is Germany, world is no region', () => {
    expect(focusRegion('DE')).toBe(GERMANY);
    expect(focusRegion('world')).toBeNull();
  });
});

describe('inFocusRegion (Germany)', () => {
  const inDe = (lat: number, lng: number) => inFocusRegion(GERMANY, lat, lng);

  it('cities inside and outside', () => {
    expect(inDe(48.7758, 9.1829)).toBe(true); // Stuttgart
    expect(inDe(53.5511, 9.9937)).toBe(true); // Hamburg
    expect(inDe(52.52, 13.405)).toBe(true); // Berlin
    expect(inDe(48.8566, 2.3522)).toBe(false); // Paris
    expect(inDe(48.2082, 16.3738)).toBe(false); // Vienna
    expect(inDe(47.3769, 8.5417)).toBe(false); // Zürich
    expect(inDe(52.3676, 4.9041)).toBe(false); // Amsterdam
    expect(inDe(48.5819, 7.7505)).toBe(false); // Strasbourg cathedral, ~4 km across the Rhine
  });

  it('a point just outside the generalised outline, within the border tolerance, still counts', () => {
    // About 0.5 km west of the outline's Upper Rhine segment at Kehl: outside the polygon itself.
    expect(pointInMultiPolygon(48.5807, 7.8044, GERMANY.polygons)).toBe(false);
    expect(distanceToRingsKm(48.5807, 7.8044, GERMANY.polygons)).toBeLessThan(1);
    expect(inDe(48.5807, 7.8044)).toBe(true);
  });

  it('rejects missing or non-finite coordinates', () => {
    expect(inDe(Number.NaN, 9)).toBe(false);
    expect(inDe(50, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('names the region in the NOT ON MAP reason', () => {
    expect(outsideFocusReason(GERMANY)).toBe('Outside map focus (Germany)');
  });
});
