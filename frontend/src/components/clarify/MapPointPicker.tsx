import * as L from 'leaflet';
import { useEffect, useRef } from 'react';
import { COL } from '../../theme';
import { basemapTileLayer, compactAttribution, removeMap } from '../leaflet';
import styles from './Clarify.module.css';
import { parseNumber } from './clarifyModel';

/** A point that helps to find the place: another borehole of the same report that is on the map. */
export interface ReferencePoint { label: string; lat: number; lng: number }

interface Props {
  /** Latitude and longitude as typed (WGS84 degrees); '' when not set. */
  lat: string;
  lon: string;
  onChange(lat: string, lon: string): void;
  reference: readonly ReferencePoint[];
  /** Accessible name of the map. */
  label: string;
}

const WORLD: L.LatLngTuple = [20, 0];
const POINT_ZOOM = 14;
/** About 0.1 m: more digits than a click can mean. */
const DECIMALS = 6;

const round = (x: number) => String(Number(x.toFixed(DECIMALS)));

/** The typed point when it is a valid WGS84 position, else null (plain numbers: no Leaflet while rendering). */
function pointOf(lat: string, lon: string): L.LatLngTuple | null {
  const la = parseNumber(lat);
  const lo = parseNumber(lon);
  if (la === null || lo === null || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  return [la, lo];
}

/**
 * The map of a map_point field (FRONTEND.md F12): a click places the one point (the latitude and
 * longitude inputs next to it are the keyboard path and show the clicked values). Other boreholes of
 * the report that are on the map are drawn as grey reference pins; the view starts on them, or on
 * the world. Nothing is placed until the reviewer clicks or types.
 */
export function MapPointPicker({ lat, lon, onChange, reference, label }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.CircleMarker | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const initial = useRef({ point: pointOf(lat, lon), reference });

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const m = L.map(node, { zoomControl: true, attributionControl: false });
    compactAttribution().addTo(m);
    basemapTileLayer().addTo(m);
    const { point, reference: refs } = initial.current;
    for (const r of refs) {
      L.circleMarker([r.lat, r.lng], { radius: 5, color: '#fff', weight: 1.5, fillColor: COL.grey, fillOpacity: 1 })
        .bindTooltip(r.label, { direction: 'top', offset: [0, -5] })
        .addTo(m);
    }
    if (point) m.setView(point, POINT_ZOOM);
    else if (refs.length) m.fitBounds(L.latLngBounds(refs.map((r) => L.latLng(r.lat, r.lng))), { padding: [30, 30], maxZoom: POINT_ZOOM, animate: false });
    else m.setView(WORLD, 1);
    m.on('click', (e: L.LeafletMouseEvent) => {
      const p = e.latlng.wrap();
      change.current(round(p.lat), round(p.lng));
    });
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(node);
    return () => {
      ro.disconnect();
      removeMap(m);
      map.current = null;
      marker.current = null;
    };
  }, []);

  // The marker follows the inputs (a click, or typing); an incomplete or invalid point shows none.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const p = pointOf(lat, lon);
    if (!p) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    if (!marker.current) {
      marker.current = L.circleMarker(p, { radius: 8, color: '#fff', weight: 2, fillColor: COL.green, fillOpacity: 1 }).addTo(m);
    } else {
      marker.current.setLatLng(p);
    }
    if (!m.getBounds().contains(L.latLng(p))) m.panTo(p, { animate: false });
  }, [lat, lon]);

  return <div ref={el} className={styles.pointMap} aria-label={label} />;
}
