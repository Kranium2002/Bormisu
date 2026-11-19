import { describe, expect, it } from 'vitest';
import { viewArea } from './viewArea';

describe('viewArea: the box a map view shows', () => {
  it('is centred on the view and as wide as the map is at that zoom', () => {
    // Zoom 14: the world is 256 × 2^14 px wide, so 1024 px are 360 × 1024 / 4194304 degrees of longitude.
    const a = viewArea({ lat: 48.47, lng: 7.94, zoom: 14 }, { width: 1024, height: 768 });
    expect(a?.type).toBe('bbox');
    const [w, s, e, n] = a!.type === 'bbox' ? a!.bbox : [0, 0, 0, 0];
    expect(e - w).toBeCloseTo((360 * 1024) / (256 * 2 ** 14), 5);
    expect((w + e) / 2).toBeCloseTo(7.94, 5);
    expect(s).toBeLessThan(48.47);
    expect(n).toBeGreaterThan(48.47);
    // Mercator: about cos(latitude) as many degrees of latitude per pixel as of longitude.
    expect((n - s) / (e - w)).toBeCloseTo((768 / 1024) * Math.cos((48.47 * Math.PI) / 180), 2);
  });

  it('stays on the globe when the map shows more than the world', () => {
    const a = viewArea({ lat: 0, lng: 0, zoom: 0 }, { width: 2000, height: 2000 });
    expect(a).toEqual({ type: 'bbox', bbox: [-180, -85.051129, 180, 85.051129] });
  });

  it('is null for a map without a size', () => {
    expect(viewArea({ lat: 48, lng: 8, zoom: 10 }, { width: 0, height: 600 })).toBeNull();
  });
});
