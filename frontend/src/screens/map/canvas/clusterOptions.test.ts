import { describe, expect, it } from 'vitest';
import { clusterOptions, CLUSTER_RADIUS_PX, MAP_MAX_ZOOM } from './clusterOptions';
import { useColourMode } from './colourMode';

describe('F9: clustering setup', () => {
  it('loads pins in chunks, spiderfies at the maximum zoom and drops clusters off-screen', () => {
    const o = clusterOptions(false);
    expect(o.chunkedLoading).toBe(true);
    // Each chunk gives the browser a frame back (5,000 pins never block the page).
    expect(o.chunkInterval).toBeLessThanOrEqual(100);
    expect(o.chunkDelay).toBeGreaterThan(0);
    expect(o.spiderfyOnMaxZoom).toBe(true);
    expect(o.zoomToBoundsOnClick).toBe(true);
    expect(o.removeOutsideVisibleBounds).toBe(true);
    expect(o.showCoverageOnHover).toBe(false);
    expect(o.maxClusterRadius).toBe(CLUSTER_RADIUS_PX);
    expect(o.animateAddingMarkers).toBe(false);
  });

  it('animates clusters unless the user prefers reduced motion', () => {
    expect(clusterOptions(false).animate).toBe(true);
    expect(clusterOptions(true).animate).toBe(false);
  });

  it('spider legs do not take clicks; the map has a finite maximum zoom for spiderfying', () => {
    expect(clusterOptions(false).spiderLegPolylineOptions.interactive).toBe(false);
    expect(Number.isFinite(MAP_MAX_ZOOM)).toBe(true);
  });
});

describe('colour mode', () => {
  it('starts on the review status and switches to depth', () => {
    expect(useColourMode.getState().colourBy).toBe('status');
    useColourMode.getState().setColourBy('depth');
    expect(useColourMode.getState().colourBy).toBe('depth');
    useColourMode.getState().setColourBy('status');
  });
});
