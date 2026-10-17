/**
 * The Leaflet map of the Map screen (prototype initMap / fly). Leaflet is driven directly through
 * refs: React owns the container, Leaflet owns everything inside it.
 *
 * - One circle marker per plotted borehole, coloured by review status and restyled in place when a
 *   status, a position or the highlighted borehole changes.
 * - Clicking a pin opens a popup with OPEN DETAIL ›.
 * - A new `focus` signal (header search) flies to the borehole and opens its popup.
 * - App unmounts the screen on navigation, so the view is kept in a module variable and restored.
 * - The first view fits the pins, or shows the whole world while nothing is plotted.
 */
import * as L from 'leaflet';
import { useEffect, useRef } from 'react';
import { osmTileLayer, removeMap } from '../../components/leaflet';
import type { Borehole, BoreholeStatus } from '../../domain/types';
import type { MapFocus } from '../../store/appStore';
import { pinColor } from '../../theme';
import styles from './BoreholeMap.module.css';
import {
  depthText,
  initialBounds,
  isPlotted,
  PIN_RADIUS,
  popupCrsWarning,
  WORLD_BOUNDS,
  WORLD_CENTER,
  WORLD_ZOOM,
} from './mapModel';
import { buildPopup } from './mapPopup';

/** Prototype timings: fly 60 ms after the request, open the popup once the 0.8 s flight is over. */
const FLY_DELAY_MS = 60;
const FLY_DURATION_S = 0.8;
const POPUP_DELAY_MS = 850;

/** Last map view, kept across screen changes (the screen unmounts when you leave it). */
let savedView: { center: L.LatLngTuple; zoom: number } | null = null;
/** The last search focus flown to, so coming back to the map doesn't fly again. */
let handledFocusNonce: number | null = null;

interface Props {
  boreholes: Borehole[];
  statuses: Map<string, BoreholeStatus>;
  /** Drawn with the larger radius and on top (the borehole open in Review). */
  highlightUid: string | null;
  focus: MapFocus | null;
  onOpen(uid: string): void;
}

function pinStyle(status: BoreholeStatus, highlight: boolean): L.CircleMarkerOptions {
  return {
    radius: highlight ? PIN_RADIUS.highlight : PIN_RADIUS.normal,
    color: '#fff',
    weight: 2,
    fillColor: pinColor(status),
    fillOpacity: 1,
  };
}

export function BoreholeMap({ boreholes, statuses, highlightUid, focus, onOpen }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef(new Map<string, L.CircleMarker>());
  /** Latest props for Leaflet callbacks, which outlive a render. */
  const latest = useRef({ boreholes, statuses, onOpen });
  useEffect(() => {
    latest.current = { boreholes, statuses, onOpen };
  });

  // Create the map once; keep its view when the screen unmounts.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const map = L.map(el, { scrollWheelZoom: true, zoomSnap: 0.25 });
    // The pins' bounds, or the whole world while nothing is plotted: no country is built in.
    const bounds = initialBounds(latest.current.boreholes);
    const world = bounds === WORLD_BOUNDS;
    if (savedView) map.setView(savedView.center, savedView.zoom);
    else if (el.clientWidth > 0 && el.clientHeight > 0) map.fitBounds(bounds, world ? {} : { padding: [24, 24], maxZoom: 13 });
    else map.setView(world ? WORLD_CENTER : L.latLngBounds(bounds).getCenter(), world ? WORLD_ZOOM : 6);
    osmTileLayer().addTo(map);
    mapRef.current = map;

    // Recompute the map size whenever the container changes size (first layout, window resize).
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(el);
    const markers = markersRef.current;

    return () => {
      resize.disconnect();
      const c = map.getCenter();
      savedView = { center: [c.lat, c.lng], zoom: map.getZoom() };
      removeMap(map);
      markers.clear();
      mapRef.current = null;
    };
  }, []);

  // Add, restyle, move and remove pins as the data changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    /** Popup content, built from the latest data each time the popup opens. */
    const popupFor = (uid: string): HTMLElement => {
      const { boreholes: all, statuses: st, onOpen: open } = latest.current;
      const b = all.find((x) => x.uid === uid);
      if (!b) return document.createElement('div');
      return buildPopup(
        {
          id: b.id,
          project: b.project,
          depth: depthText(b),
          status: st.get(uid) ?? 'unreviewed',
          crsWarning: popupCrsWarning(b.crs),
        },
        () => {
          map.closePopup();
          open(uid);
        },
      );
    };

    const markers = markersRef.current;
    const seen = new Set<string>();
    for (const b of boreholes) {
      if (!isPlotted(b)) continue;
      seen.add(b.uid);
      const style = pinStyle(statuses.get(b.uid) ?? 'unreviewed', b.uid === highlightUid);
      const existing = markers.get(b.uid);
      if (existing) {
        existing.setLatLng([b.lat, b.lng]);
        existing.setStyle(style);
        if (existing.isPopupOpen()) existing.setPopupContent(popupFor(b.uid));
      } else {
        const uid = b.uid;
        const m = L.circleMarker([b.lat, b.lng], style).addTo(map);
        m.bindPopup(() => popupFor(uid));
        markers.set(uid, m);
      }
    }
    for (const [uid, m] of markers) {
      if (!seen.has(uid)) {
        m.remove();
        markers.delete(uid);
      }
    }
    if (highlightUid) markers.get(highlightUid)?.bringToFront();
  }, [boreholes, statuses, highlightUid]);

  // Fly to a searched borehole and open its popup (prototype fly()).
  useEffect(() => {
    if (!focus || focus.nonce === handledFocusNonce) return;
    const b = latest.current.boreholes.find((x) => x.uid === focus.uid);
    if (!b || !isPlotted(b)) {
      handledFocusNonce = focus.nonce;
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(
      setTimeout(() => {
        const map = mapRef.current;
        if (!map) return;
        // Marked handled only once the flight starts, so StrictMode's effect re-run still flies.
        handledFocusNonce = focus.nonce;
        map.closePopup();
        map.invalidateSize();
        map.flyTo([b.lat, b.lng], focus.zoom, { duration: FLY_DURATION_S });
        timers.push(setTimeout(() => markersRef.current.get(b.uid)?.openPopup(), POPUP_DELAY_MS));
      }, FLY_DELAY_MS),
    );
    return () => timers.forEach(clearTimeout);
  }, [focus]);

  return <div ref={containerRef} className={styles.map} role="region" aria-label="Borehole map" />;
}
