import { describe, expect, it, vi } from 'vitest';
import { currentPosition, LOCATE_MESSAGES, locateErrorMessage, parseLatLng, POSITION_OPTIONS, type GeoEnv } from './geolocate';

const env = (getCurrentPosition: Geolocation['getCurrentPosition'], isSecureContext = true): GeoEnv => ({
  isSecureContext,
  geolocation: { getCurrentPosition },
});

describe('currentPosition', () => {
  it('resolves with lat, lng and accuracy, asking with the agreed options', async () => {
    const get = vi.fn<Geolocation['getCurrentPosition']>((ok) =>
      ok({ coords: { latitude: 48.79, longitude: 9.18, accuracy: 12 } } as GeolocationPosition),
    );
    await expect(currentPosition(env(get))).resolves.toEqual({ lat: 48.79, lng: 9.18, accuracyM: 12 });
    expect(get.mock.calls[0][2]).toEqual({ enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
    expect(POSITION_OPTIONS.timeout).toBe(10_000);
  });

  it('turns browser errors into the texts the UI shows', async () => {
    const failing = (code: number) => env((_, err) => err?.({ code } as GeolocationPositionError));
    await expect(currentPosition(failing(1))).rejects.toThrow(LOCATE_MESSAGES.denied);
    await expect(currentPosition(failing(2))).rejects.toThrow(LOCATE_MESSAGES.unavailable);
    await expect(currentPosition(failing(3))).rejects.toThrow(LOCATE_MESSAGES.timeout);
    expect(LOCATE_MESSAGES.denied).toBe('Location permission denied. Allow it in the browser to see boreholes near you.');
    expect(locateErrorMessage(99)).toBe(LOCATE_MESSAGES.unavailable);
  });

  it('refuses outside a secure context and without the API, without asking', async () => {
    const get = vi.fn();
    await expect(currentPosition(env(get, false))).rejects.toThrow('Location needs HTTPS (or localhost).');
    expect(get).not.toHaveBeenCalled();
    await expect(currentPosition({ isSecureContext: true, geolocation: undefined })).rejects.toThrow(LOCATE_MESSAGES.unsupported);
  });
});

describe('parseLatLng', () => {
  it('accepts "lat,lng" in range, nothing else', () => {
    expect(parseLatLng('48.7912,9.1846')).toEqual({ lat: 48.7912, lng: 9.1846 });
    expect(parseLatLng(' -33.45 , -70.66 ')).toEqual({ lat: -33.45, lng: -70.66 });
    expect(parseLatLng('91,0')).toBeNull();
    expect(parseLatLng('0,181')).toBeNull();
    expect(parseLatLng('48.79')).toBeNull();
    expect(parseLatLng('a,b')).toBeNull();
    expect(parseLatLng(null)).toBeNull();
  });
});
