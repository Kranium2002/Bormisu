/**
 * Clustering setup of the borehole map (leaflet.markercluster), as plain options so it is unit-tested
 * without Leaflet (pinLayer.ts adds the icon function and creates the group):
 * - chunked loading, so 5,000 pins never block the page while they are added;
 * - spiderfy at the maximum zoom (boreholes at one spot fan out), no coverage polygon on hover;
 * - clusters off-screen are not kept on the map (Leaflet's default, for panning speed);
 * - no cluster animations under prefers-reduced-motion.
 */
import type { MarkerClusterGroupOptions } from 'leaflet';
import { COL } from '../../../theme';

/** Pins closer than this (screen px) at a zoom form one cluster. */
export const CLUSTER_RADIUS_PX = 60;

/** The map's maximum zoom (the basemap's tiles go to 19); markercluster needs a finite one. */
export const MAP_MAX_ZOOM = 19;

/** Options of the cluster group without the icon function. */
export type ClusterSetup = Required<
  Pick<
    MarkerClusterGroupOptions,
    | 'chunkedLoading'
    | 'chunkInterval'
    | 'chunkDelay'
    | 'spiderfyOnMaxZoom'
    | 'showCoverageOnHover'
    | 'zoomToBoundsOnClick'
    | 'removeOutsideVisibleBounds'
    | 'maxClusterRadius'
    | 'animate'
    | 'animateAddingMarkers'
    | 'spiderLegPolylineOptions'
  >
>;

export function clusterOptions(reducedMotion: boolean): ClusterSetup {
  return {
    chunkedLoading: true,
    // At most ~100 ms of work per chunk, then a frame back to the browser.
    chunkInterval: 100,
    chunkDelay: 16,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
    removeOutsideVisibleBounds: true,
    maxClusterRadius: CLUSTER_RADIUS_PX,
    animate: !reducedMotion,
    animateAddingMarkers: false,
    spiderLegPolylineOptions: { weight: 1.5, color: COL.dark, opacity: 0.6, interactive: false },
  };
}
