/**
 * Shapes drawn over the pins' map: the selected area (a drawn rectangle, polygon or circle, or the
 * area a result set echoes) and the dashed outline of a place or a fit_bounds (FRONTEND.md F10, F11).
 * Both are plain Leaflet paths on the overlay pane under the pins' canvas, and take no clicks, so
 * the pins inside them stay clickable. Each is replaced, never stacked: one area and one outline at
 * a time. The path elements carry `data-map-shape="area" | "outline"`.
 */
import * as L from 'leaflet';
import type { Area } from '../../../domain/types';
import { COL } from '../../../theme';
import { bboxBounds, type Bbox } from '../mapModel';

const AREA_STYLE: L.PathOptions = { color: COL.dark, weight: 2, opacity: 0.9, fillColor: COL.dark, fillOpacity: 0.06, interactive: false };
const OUTLINE_STYLE: L.PathOptions = { color: COL.dark, weight: 2, opacity: 0.9, dashArray: '6 6', fill: false, interactive: false };

/** The Leaflet path of an Area; null for a polygon without a usable ring. */
export function areaPath(area: Area): L.Path | null {
  switch (area.type) {
    case 'bbox':
      return L.rectangle(bboxBounds(area.bbox), AREA_STYLE);
    case 'polygon': {
      const rings = Array.isArray(area.polygon?.coordinates) ? area.polygon.coordinates : [];
      const latlngs = rings.map((ring) => ring.filter((p) => p.length >= 2).map(([lng, lat]) => [lat, lng] as L.LatLngTuple));
      return latlngs[0]?.length >= 3 ? L.polygon(latlngs, AREA_STYLE) : null;
    }
    case 'circle':
      return L.circle([area.center[1], area.center[0]], { ...AREA_STYLE, radius: area.radiusM });
  }
}

interface Shown {
  key: string;
  path: L.Path;
}

export class MapShapes {
  private area: Shown | null = null;
  private outline: Shown | null = null;

  constructor(private readonly map: L.Map) {}

  /** Shows this area (replacing the one shown), or none. The same area again changes nothing. */
  setArea(area: Area | null): void {
    this.area = this.replace(this.area, area ? JSON.stringify(area) : null, () => (area ? areaPath(area) : null), 'area');
  }

  /** Draws the dashed outline of this bbox (replacing the one shown), or none. */
  setOutline(bbox: Bbox | null): void {
    this.outline = this.replace(this.outline, bbox ? bbox.join(',') : null, () => (bbox ? L.rectangle(bboxBounds(bbox), OUTLINE_STYLE) : null), 'outline');
  }

  destroy(): void {
    this.setArea(null);
    this.setOutline(null);
  }

  private replace(shown: Shown | null, key: string | null, make: () => L.Path | null, kind: 'area' | 'outline'): Shown | null {
    if (shown && shown.key === key) return shown;
    shown?.path.remove();
    if (key == null) return null;
    const path = make();
    if (!path) return null;
    path.addTo(this.map);
    path.getElement()?.setAttribute('data-map-shape', kind);
    return { key, path };
  }
}
