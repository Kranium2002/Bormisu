/** The real country outlines for unit tests, read from the asset at transform time (no fetch). */
import raw from '../geo/countries-50m.json?raw';
import { decodeCountries, type Country } from '../geo/countries';

export const COUNTRIES: Country[] = decodeCountries(JSON.parse(raw));

/** The country with this ISO code; throws if the asset has none. */
export function country(code: string): Country {
  const c = COUNTRIES.find((x) => x.code === code);
  if (!c) throw new Error(`no country ${code} in the asset`);
  return c;
}
