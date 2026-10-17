import { afterEach, describe, expect, it, vi } from 'vitest';
import { COUNTRIES, country } from '../test/countries';
import { decodeCountries, decodeRing } from './countries';
import { inBox, pointInPolygon } from './polygon';

describe('decodeRing', () => {
  it('turns integer deltas into [lat, lng] points', () => {
    expect(decodeRing([48775, 9183, 10, -20, -5, 5], 1000)).toEqual([
      [48.775, 9.183],
      [48.785, 9.163],
      [48.78, 9.168],
    ]);
  });
});

describe('decodeCountries', () => {
  it('rejects anything that is not the expected format', () => {
    expect(() => decodeCountries(null)).toThrow(/unexpected file format/);
    expect(() => decodeCountries({ scale: 1000, countries: [{ code: 'de', name: 'x', polygons: [] }] })).toThrow(/bad country/);
    expect(() =>
      decodeCountries({ scale: 1000, countries: [{ code: 'DE', name: 'x', bbox: [[0, 0], [1, 1]], view: [[0, 0], [1, 1]], polygons: [[[1, 2, 3]]] }] }),
    ).toThrow(/bad ring/);
  });
});

describe('the Natural Earth asset', () => {
  it('has the countries with ISO codes and English names, codes unique', () => {
    expect(COUNTRIES.length).toBeGreaterThan(230);
    expect(new Set(COUNTRIES.map((c) => c.code)).size).toBe(COUNTRIES.length);
    expect(country('DE').name).toBe('Germany');
    expect(country('CH').name).toBe('Switzerland');
    expect(country('NO').name).toBe('Norway');
    expect(country('FR').name).toBe('France');
    expect(country('SG').name).toBe('Singapore');
  });

  it('every point lies in its country bounds and every polygon in its own box', () => {
    for (const c of COUNTRIES) {
      c.polygons.forEach((p, i) => {
        for (const [lat, lng] of p[0]) {
          expect(inBox(lat, lng, c.bounds), c.code).toBe(true);
          expect(inBox(lat, lng, c.polygonBounds[i]), c.code).toBe(true);
        }
      });
    }
  });

  it('the view box is the main territory, without overseas parts', () => {
    const [[s, w], [n, e]] = country('FR').view;
    expect([s > 41, w > -6, n < 52, e < 10]).toEqual([true, true, true, true]); // metropolitan France + Corsica
    expect(country('FR').bounds[0][0]).toBeLessThan(-20); // Réunion is still in the outline
    expect(country('NO').view[1][0]).toBeLessThan(72); // without Svalbard
    expect(country('DE').view).toEqual(country('DE').bounds);
  });

  it('Germany keeps its islands: mainland first, Fehmarn and Rügen as own polygons', () => {
    const de = country('DE');
    expect(de.polygons.length).toBeGreaterThanOrEqual(5);
    const islandOf = (lat: number, lng: number) => de.polygons.findIndex((p) => pointInPolygon(lat, lng, p));
    expect(islandOf(48.7758, 9.1829)).toBe(0); // Stuttgart, mainland
    expect(islandOf(54.4369, 11.1953)).toBeGreaterThan(0); // Fehmarn
    expect(islandOf(54.4167, 13.4333)).toBeGreaterThan(0); // Bergen auf Rügen
  });
});

describe('loadCountries', () => {
  afterEach(() => vi.resetModules());

  it('fetches once and decodes; a failed load is retried on the next call', async () => {
    const { loadCountries, loadedCountries } = await import('./countries');
    const failing = vi.fn(async () => new Response('nope', { status: 404 }));
    await expect(loadCountries(failing as unknown as typeof fetch)).rejects.toThrow(/HTTP 404/);
    expect(loadedCountries()).toBeNull();

    const body = JSON.stringify({ scale: 1000, countries: [{ code: 'XX', name: 'Testland', bbox: [[0, 0], [1, 1]], view: [[0, 0], [1, 1]], polygons: [[[0, 0, 1000, 0, 0, 1000]]] }] });
    const ok = vi.fn(async () => new Response(body, { status: 200 }));
    const first = await loadCountries(ok as unknown as typeof fetch);
    const second = await loadCountries(ok as unknown as typeof fetch);
    expect(first).toBe(second);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(first[0]).toMatchObject({ code: 'XX', name: 'Testland', polygons: [[[[0, 0], [1, 0], [1, 1]]]] });
    expect(loadedCountries()).toBe(first);
  });
});
