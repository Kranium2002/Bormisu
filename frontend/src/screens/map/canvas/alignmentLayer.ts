/**
 * The planned line on the map (contract 1.3.0): the line itself and its translucent search band, on
 * the overlay pane under the pins' canvas, taking no clicks (the pins inside stay clickable). The band
 * is redrawn when the search distance changes; the line only when another line is shown. The paths
 * carry `data-map-shape="alignment"` (line) and `"alignment-band"` (band) for the e2e suites.
 */
import * as L from 'leaflet';
import { COL } from '../../../theme';

const LINE_STYLE: L.PolylineOptions = { color: COL.red, weight: 3, opacity: 0.95, interactive: false };
const BAND_STYLE: L.PathOptions = { color: COL.red, weight: 1, opacity: 0.6, dashArray: '4 4', fillColor: COL.red, fillOpacity: 0.1, interactive: false };

const toLatLngs = (ring: readonly [number, number][]) => ring.map(([lng, lat]) => [lat, lng] as L.LatLngTuple);

export class AlignmentLayer {
  private line: { key: string; path: L.Polyline } | null = null;
  private band: { key: string; path: L.Polygon } | null = null;

  constructor(private readonly map: L.Map) {}

  /** Shows this line (parts of [lng, lat]), or none. */
  setLine(id: string | null, parts: readonly [number, number][][] | null): void {
    const key = id && parts?.length ? id : null;
    if (this.line?.key === key) return;
    this.line?.path.remove();
    this.line = null;
    if (!key || !parts) return;
    const path = L.polyline(parts.map(toLatLngs), LINE_STYLE).addTo(this.map);
    path.getElement()?.setAttribute('data-map-shape', 'alignment');
    this.line = { key, path };
  }

  /** Shows this band (polygons of rings of [lng, lat]), or none. */
  setBand(polygons: readonly [number, number][][][] | null): void {
    const key = polygons?.length ? JSON.stringify(polygons) : null;
    if (this.band?.key === key) return;
    this.band?.path.remove();
    this.band = null;
    if (!key || !polygons) return;
    const path = L.polygon(polygons.map((rings) => rings.map(toLatLngs)), BAND_STYLE).addTo(this.map);
    path.getElement()?.setAttribute('data-map-shape', 'alignment-band');
    // The line stays on top of its band.
    this.line?.path.bringToFront();
    this.band = { key, path };
  }

  destroy(): void {
    this.setLine(null, null);
    this.setBand(null);
  }
}
