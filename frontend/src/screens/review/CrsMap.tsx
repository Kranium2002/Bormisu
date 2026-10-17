import * as L from 'leaflet';
import { useEffect, useRef } from 'react';
import { compactAttribution, osmTileLayer, removeMap } from '../../components/leaflet';
import type { CrsCandidate } from '../../domain/types';
import { COL } from '../../theme';
import styles from './CrsDialog.module.css';
import { siteCentre } from './reviewView';

/** Radius of the dashed "site per report text" circle, metres (prototype: 9 km). */
const SITE_RADIUS_M = 9000;
/** View before the candidates arrive: the whole world (the candidates' bounds replace it). */
const WORLD: L.LatLngTuple = [20, 0];

interface Props {
  candidates: CrsCandidate[];
  pick: number;
  /** Borehole ID per uid, for the pin tooltips. */
  labels: Record<string, string>;
}

/** Pin colour by the backend's verdict: green = match, red = shifted, grey = no verdict. */
function pinFill(c: CrsCandidate): string {
  if (c.verdict === 'match') return COL.green;
  if (c.verdict === 'shifted') return COL.red;
  return COL.grey;
}

/**
 * Leaflet map of the CRS dialog: the picked candidate's pins (coloured by verdict) and the dashed
 * site circle at the centroid of the matching candidate. The view covers every candidate, so
 * switching candidates shows the pins jump.
 */
export function CrsMap({ candidates, pick, labels }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { zoomControl: true, attributionControl: false }).setView(WORLD, 2);
    compactAttribution().addTo(m);
    osmTileLayer().addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    const raf = requestAnimationFrame(() => m.invalidateSize());
    return () => {
      cancelAnimationFrame(raf);
      removeMap(m);
      map.current = null;
      layer.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const pts = candidates.flatMap((c) => c.points.map((p) => L.latLng(p.lat, p.lng)));
    if (!m || !pts.length) return;
    const bounds = L.latLngBounds(pts);
    const site = siteCentre(candidates);
    if (site) bounds.extend(L.latLng(site.lat, site.lng).toBounds(SITE_RADIUS_M * 2));
    m.fitBounds(bounds, { padding: [36, 36], maxZoom: 12 });
  }, [candidates]);

  useEffect(() => {
    const g = layer.current;
    if (!g) return;
    g.clearLayers();
    const c = candidates[pick];
    if (!c || c.verdict === 'out_of_range') return;
    const fill = pinFill(c);
    for (const p of c.points) {
      L.circleMarker([p.lat, p.lng], { radius: 6, color: '#fff', weight: 2, fillColor: fill, fillOpacity: 1 })
        .bindTooltip(labels[p.uid] ?? p.uid, { direction: 'top', offset: [0, -6] })
        .addTo(g);
    }
    const site = siteCentre(candidates);
    if (site) {
      L.circle([site.lat, site.lng], { radius: SITE_RADIUS_M, color: COL.dark, weight: 1.5, dashArray: '4 4', fill: false })
        .bindTooltip('Site per report text', { permanent: true, direction: 'top' })
        .addTo(g);
    }
  }, [candidates, pick, labels]);

  return <div ref={el} className={styles.map} aria-label="Map preview of the picked CRS" />;
}
