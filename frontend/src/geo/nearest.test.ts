import { describe, expect, it } from 'vitest';
import { bearingDeg, compass, formatDistance, haversineM, nearest } from './nearest';

const STUTTGART = { lat: 48.7758, lng: 9.1829 };
const MUNICH = { lat: 48.1351, lng: 11.582 };

describe('haversineM', () => {
  it('is zero for the same point and symmetric', () => {
    expect(haversineM(STUTTGART, STUTTGART)).toBe(0);
    expect(haversineM(STUTTGART, MUNICH)).toBeCloseTo(haversineM(MUNICH, STUTTGART), 6);
  });

  it('matches known distances', () => {
    // Stuttgart – Munich, about 190 km as the crow flies.
    expect(haversineM(STUTTGART, MUNICH) / 1000).toBeCloseTo(190.3, 0);
    // One degree of latitude is about 111.2 km; one of longitude at 60° N half of that.
    expect(haversineM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111195, -1);
    expect(haversineM({ lat: 60, lng: 0 }, { lat: 60, lng: 1 })).toBeCloseTo(55596, -1);
  });
});

describe('bearingDeg / compass', () => {
  it('points the right way', () => {
    expect(bearingDeg({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(0, 6);
    expect(bearingDeg({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(90, 6);
    expect(bearingDeg({ lat: 0, lng: 0 }, { lat: -1, lng: 0 })).toBeCloseTo(180, 6);
    expect(bearingDeg({ lat: 0, lng: 0 }, { lat: 0, lng: -1 })).toBeCloseTo(270, 6);
    // Hamburg lies almost due north of Stuttgart; Munich at about 111° (E, just short of ESE).
    expect(compass(bearingDeg(STUTTGART, { lat: 53.5511, lng: 9.9937 }))).toBe('N');
    expect(bearingDeg(STUTTGART, MUNICH)).toBeCloseTo(111, 0);
    expect(compass(bearingDeg(STUTTGART, MUNICH))).toBe('E');
    expect(compass(bearingDeg({ lat: 0, lng: 0 }, { lat: -1, lng: 1 }))).toBe('SE');
  });

  it('eight points, with the boundaries halfway between them', () => {
    expect([0, 22.4, 22.6, 90, 135, 180, 225, 270, 315, 337.4, 337.6, 359.9].map(compass)).toEqual([
      'N', 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'NW', 'N', 'N',
    ]);
    expect(compass(-45)).toBe('NW');
    expect(compass(405)).toBe('NE');
  });
});

describe('nearest', () => {
  const pts = [
    { id: 'far', lat: 48.9, lng: 9.3 },
    { id: 'near', lat: 48.7905, lng: 9.1835 },
    { id: 'mid', lat: 48.8, lng: 9.2 },
    { id: 'near-twin', lat: 48.7905, lng: 9.1835 },
  ];
  const here = { lat: 48.7912, lng: 9.1846 };

  it('returns the k nearest, nearest first, ties in input order, with distance and direction', () => {
    const r = nearest(here, pts, 3);
    expect(r.map((n) => n.item.id)).toEqual(['near', 'near-twin', 'mid']);
    expect(r[0].distanceM).toBeGreaterThan(100);
    expect(r[0].distanceM).toBeLessThan(125);
    expect(r[0].direction).toBe('SW');
    expect(r[2].direction).toBe('NE');
  });

  it('copes with k larger than the list, zero and no items', () => {
    expect(nearest(here, pts, 10)).toHaveLength(4);
    expect(nearest(here, pts, 0)).toEqual([]);
    expect(nearest(here, [], 5)).toEqual([]);
  });
});

describe('formatDistance', () => {
  it('metres below 1 km, else km with one decimal', () => {
    expect(formatDistance(0)).toBe('0 m');
    expect(formatDistance(112.4)).toBe('112 m');
    expect(formatDistance(999.4)).toBe('999 m');
    expect(formatDistance(999.6)).toBe('1.0 km');
    expect(formatDistance(1234)).toBe('1.2 km');
    expect(formatDistance(23456)).toBe('23.5 km');
  });
});
