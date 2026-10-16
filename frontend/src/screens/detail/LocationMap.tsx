import * as L from 'leaflet';
import { useEffect, useRef } from 'react';
import { compactAttribution, osmTileLayer, removeMap } from '../../components/leaflet';
import styles from './MetadataCard.module.css';

interface Props {
  lat: number;
  lng: number;
  /** Pin fill, by review status. */
  color: string;
  label: string;
}

const ZOOM = 14;

/** Small static Leaflet map (zoom 14, no controls) with one pin coloured by review status. */
export function LocationMap({ lat, lng, color, label }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const pinRef = useRef<L.CircleMarker | null>(null);
  // Position + colour at mount time; later changes go through the update effect below.
  const initial = useRef({ lat, lng, color });

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const { lat: la, lng: ln, color: c } = initial.current;
    const map = L.map(el, { zoomControl: false, attributionControl: false }).setView([la, ln], ZOOM);
    compactAttribution().addTo(map);
    osmTileLayer().addTo(map);
    pinRef.current = L.circleMarker([la, ln], { radius: 8, color: '#fff', weight: 2, fillColor: c, fillOpacity: 1 }).addTo(map);
    mapRef.current = map;
    // The card can change size after mount (fonts, sticky header): keep the tiles in step.
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      removeMap(map);
      mapRef.current = null;
      pinRef.current = null;
    };
  }, []);

  useEffect(() => {
    mapRef.current?.setView([lat, lng], ZOOM);
    pinRef.current?.setLatLng([lat, lng]);
  }, [lat, lng]);

  useEffect(() => {
    pinRef.current?.setStyle({ fillColor: color });
  }, [color]);

  return <div ref={elRef} className={styles.map} role="img" aria-label={label} />;
}
