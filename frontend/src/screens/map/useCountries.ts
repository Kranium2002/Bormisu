/** Loads the country outlines (src/geo/countries.ts) for the Map screen, once per page load. */
import { useEffect, useState } from 'react';
import { loadCountries, loadedCountries, type Country } from '../../geo/countries';

export interface CountriesState {
  /** The outlines once loaded, else null. */
  countries: Country[] | null;
  /** Why loading failed, else null. The map then shows the world. */
  error: string | null;
}

export function useCountries(): CountriesState {
  const [state, setState] = useState<CountriesState>(() => ({ countries: loadedCountries(), error: null }));
  useEffect(() => {
    if (state.countries) return;
    let live = true;
    loadCountries().then(
      (countries) => live && setState({ countries, error: null }),
      (e: unknown) => live && setState({ countries: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [state.countries]);
  return state;
}
