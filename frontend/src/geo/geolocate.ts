/**
 * The browser's position for the map's MY LOCATION button, with the error texts the UI shows.
 * The position is only returned to the caller: nothing here sends, stores or logs it.
 */
import type { GeoPoint } from './nearest';

export interface PositionFix extends GeoPoint {
  /** Radius (m) of the 95 % confidence circle, as the browser reports it. */
  accuracyM: number;
}

/** As asked for: GPS if there is one, give up after 10 s, a fix up to 30 s old is fine. */
export const POSITION_OPTIONS: PositionOptions = { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 };

export const LOCATE_MESSAGES = {
  insecure: 'Location needs HTTPS (or localhost).',
  unsupported: 'This browser cannot share its location.',
  denied: 'Location permission denied. Allow it in the browser to see boreholes near you.',
  unavailable: 'Position unavailable. Check that location services are on, then try again.',
  timeout: 'Locating took longer than 10 s. Try again, ideally outdoors.',
} as const;

/** The parts of `window` this needs, so tests can pass their own. */
export interface GeoEnv {
  isSecureContext: boolean;
  geolocation: Pick<Geolocation, 'getCurrentPosition'> | undefined;
}

/** GeolocationPositionError.code → message (1 denied, 2 unavailable, 3 timeout). */
export function locateErrorMessage(code: number): string {
  if (code === 1) return LOCATE_MESSAGES.denied;
  if (code === 3) return LOCATE_MESSAGES.timeout;
  return LOCATE_MESSAGES.unavailable;
}

/** Asks the browser for one position. Rejects with an Error whose message is the text to show. */
export function currentPosition(env: GeoEnv): Promise<PositionFix> {
  if (!env.isSecureContext) return Promise.reject(new Error(LOCATE_MESSAGES.insecure));
  const geo = env.geolocation;
  if (!geo) return Promise.reject(new Error(LOCATE_MESSAGES.unsupported));
  return new Promise((resolve, reject) => {
    geo.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy }),
      (e) => reject(new Error(locateErrorMessage(e.code))),
      POSITION_OPTIONS,
    );
  });
}

/** Parses "lat,lng" (e.g. the sample-mode `?simLocation=48.7912,9.1846`); null unless both are valid. */
export function parseLatLng(raw: string | null | undefined): GeoPoint | null {
  const m = raw?.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}
