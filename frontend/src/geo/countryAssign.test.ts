import { describe, expect, it } from 'vitest';
import { COUNTRIES, country } from '../test/countries';
import {
  BORDER_TOLERANCE_KM,
  containsPoint,
  countryLocator,
  createCountryLocator,
  distanceToCountryKm,
  inCountry,
  locatePoint,
} from './countryAssign';

/** Places as [lat, lng]. */
const CITIES: [string, number, number, string][] = [
  ['Stuttgart', 48.7758, 9.1829, 'DE'],
  ['Hamburg', 53.5511, 9.9937, 'DE'],
  ['Berlin', 52.52, 13.405, 'DE'],
  ['Paris', 48.8566, 2.3522, 'FR'],
  ['Vienna', 48.2082, 16.3738, 'AT'],
  ['Zürich', 47.3769, 8.5417, 'CH'],
  ['Amsterdam', 52.3676, 4.9041, 'NL'],
  ['Oslo', 59.9139, 10.7522, 'NO'],
  ['Singapore', 1.3521, 103.8198, 'SG'],
  ['Santiago de Chile', -33.4489, -70.6693, 'CL'],
  ['Sydney', -33.8688, 151.2093, 'AU'],
  ['Denver', 39.7392, -104.9903, 'US'],
  ['Moscow', 55.7558, 37.6173, 'RU'],
  ['Istanbul', 41.0082, 28.9784, 'TR'],
];

describe('locatePoint', () => {
  it.each(CITIES)('%s lies in %s', (_, lat, lng, code) => {
    expect(locatePoint(COUNTRIES, lat, lng).country).toBe(code);
  });

  it('a point at sea, far from any coast, is in no country', () => {
    expect(locatePoint(COUNTRIES, 55.0, 4.0)).toEqual({ country: null, countries: [] }); // North Sea
    expect(locatePoint(COUNTRIES, 0, -30)).toEqual({ country: null, countries: [] }); // Atlantic
  });

  it('a point just off the generalised coast, within the tolerance, belongs to the nearest country', () => {
    // Hamburg harbour is inland; a point 1 km off the North Sea coast at Cuxhaven is not.
    const offCoast = locatePoint(COUNTRIES, 53.885, 8.66);
    expect(containsPoint(country('DE'), 53.885, 8.66)).toBe(false);
    expect(offCoast.country).toBe('DE');
  });

  it('near a border the point is in both country views, its own country first', () => {
    // Kehl, on the German bank of the Rhine opposite Strasbourg: within 2 km of the French outline.
    const kehl = locatePoint(COUNTRIES, 48.5735, 7.815);
    expect(kehl.country).toBe('DE');
    expect(kehl.countries).toEqual(['DE', 'FR']);
    // Strasbourg cathedral, about 4 km from the Rhine: France only.
    expect(locatePoint(COUNTRIES, 48.5819, 7.7505)).toEqual({ country: 'FR', countries: ['FR'] });
  });

  it('rejects missing or non-finite coordinates', () => {
    expect(locatePoint(COUNTRIES, Number.NaN, 9).country).toBeNull();
    expect(locatePoint(COUNTRIES, 50, Number.POSITIVE_INFINITY).country).toBeNull();
  });

  it('honours holes: Lesotho is not South Africa', () => {
    expect(locatePoint(COUNTRIES, -29.31, 27.48).country).toBe('LS'); // Maseru
    expect(locatePoint(COUNTRIES, -26.2, 28.05).country).toBe('ZA'); // Johannesburg
  });
});

describe('outline topology', () => {
  it('shared borders are simplified identically: no point in Central Europe lies in two outlines', () => {
    const overlaps: string[] = [];
    for (let lat = 45; lat <= 55; lat += 0.05) {
      for (let lng = 5; lng <= 18; lng += 0.05) {
        const inside = COUNTRIES.filter((c) => containsPoint(c, lat, lng)).map((c) => c.code);
        if (inside.length > 1) overlaps.push(`${lat.toFixed(2)},${lng.toFixed(2)} ${inside.join('+')}`);
      }
    }
    expect(overlaps).toEqual([]);
  });
});

describe('inCountry / distanceToCountryKm', () => {
  const de = country('DE');

  it('counts points inside or within the tolerance', () => {
    expect(BORDER_TOLERANCE_KM).toBe(2);
    expect(inCountry(de, 48.7758, 9.1829)).toBe(true);
    expect(inCountry(de, 48.8566, 2.3522)).toBe(false);
    expect(inCountry(de, 53.885, 8.66)).toBe(true); // off the coast, within 2 km
    expect(inCountry(de, Number.NaN, 9)).toBe(false);
  });

  it('is Infinity beyond the search radius', () => {
    expect(distanceToCountryKm(de, 48.8566, 2.3522, 2)).toBe(Infinity);
    expect(distanceToCountryKm(de, 53.885, 8.66, 2)).toBeLessThan(2);
  });
});

describe('createCountryLocator', () => {
  it('assigns by uid and caches per coordinate', () => {
    const locator = createCountryLocator(COUNTRIES);
    const hits = locator.assign([
      { uid: 'a', lat: 48.7758, lng: 9.1829 },
      { uid: 'b', lat: 47.3769, lng: 8.5417 },
      { uid: 'c', lat: 55, lng: 4 },
    ]);
    expect([...hits].map(([uid, h]) => [uid, h.country])).toEqual([
      ['a', 'DE'],
      ['b', 'CH'],
      ['c', null],
    ]);
    // Same coordinates, same (cached) result object.
    expect(locator.locate(48.7758, 9.1829)).toBe(hits.get('a'));
  });

  it('countryLocator shares one locator per country list', () => {
    expect(countryLocator(COUNTRIES)).toBe(countryLocator(COUNTRIES));
  });
});
