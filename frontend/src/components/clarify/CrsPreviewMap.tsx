import * as L from 'leaflet';
import { useEffect, useRef } from 'react';
import type { CrsCandidate } from '../../domain/types';
import { basemapTileLayer, compactAttribution, removeMap } from '../leaflet';
import styles from './Clarify.module.css';
import { plottablePoints, verdictColor } from './crsView';

/** View before any point is known: the whole world. */
const WORLD: L.LatLngTuple = [20, 0];

interface Props {
  candidate: CrsCandidate;
  /** small: a static thumbnail beside a candidate (no controls, not focusable); large: the picked candidate. */
  size: 'small' | 'large';
  /** Borehole ID per uid, for the pin tooltips of the large map. */
  labels?: Record<string, string>;
}

/**
 * Mini-map of where one CRS candidate places the document's boreholes (FRONTEND.md F13), on the
 * configured basemap, pins coloured by the backend's verdict. Out of range: no pins, says so.
 */
export function CrsPreviewMap({ candidate, size, labels }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const small = size === 'small';
  const points = plottablePoints(candidate);

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const m = small
      ? L.map(node, {
          zoomControl: false,
          attributionControl: false,
          dragging: false,
          scrollWheelZoom: false,
          doubleClickZoom: false,
          boxZoom: false,
          keyboard: false,
          touchZoom: false,
        })
      : L.map(node, { zoomControl: true, attributionControl: false });
    // A thumbnail's tiles are credited by the large map next to it.
    if (!small) compactAttribution().addTo(m);
    basemapTileLayer().addTo(m);
    m.setView(WORLD, small ? 0 : 1);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(node);
    return () => {
      ro.disconnect();
      removeMap(m);
      map.current = null;
      layer.current = null;
    };
  }, [small]);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const pts = plottablePoints(candidate);
    const fill = verdictColor(candidate.verdict);
    for (const p of pts) {
      const pin = L.circleMarker([p.lat, p.lng], {
        radius: small ? 4 : 6,
        color: '#fff',
        weight: small ? 1 : 2,
        fillColor: fill,
        fillOpacity: 1,
        interactive: !small,
      });
      if (!small) pin.bindTooltip(labels?.[p.uid] ?? p.uid, { direction: 'top', offset: [0, -6] });
      pin.addTo(g);
    }
    if (pts.length) {
      m.fitBounds(L.latLngBounds(pts.map((p) => L.latLng(p.lat, p.lng))), {
        padding: small ? [10, 10] : [36, 36],
        maxZoom: small ? 9 : 12,
        animate: false,
      });
    }
  }, [candidate, labels, small]);

  const empty = points.length === 0;
  return (
    <div className={small ? styles.previewSmall : styles.previewLarge}>
      <div
        ref={el}
        className={styles.previewMap}
        aria-hidden={small ? true : undefined}
        aria-label={small ? undefined : `Map preview of ${candidate.name}: ${points.length} borehole${points.length === 1 ? '' : 's'} placed`}
      />
      {empty && (
        <div className={`${styles.previewNote} ${candidate.verdict === 'out_of_range' ? styles.previewNoteError : ''}`}>
          {candidate.verdict === 'out_of_range' ? 'Out of range: no pins' : 'No points to show'}
        </div>
      )}
    </div>
  );
}
