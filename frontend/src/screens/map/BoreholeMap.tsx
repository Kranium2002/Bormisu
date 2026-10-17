/**
 * The Leaflet map of the Map screen (prototype initMap / fly). Leaflet is driven directly through
 * refs: React owns the container, Leaflet owns everything inside it.
 *
 * - One circle marker per plotted borehole (a map feature), coloured by review status and restyled
 *   in place when a status, a position or the highlighted borehole changes.
 * - Clicking a pin opens a popup with OPEN DETAIL ›.
 * - URL state: the map starts at `view` (the URL's `at`); without one it shows the selected pin, else
 *   fits the pins clear of the REVIEW STATUS legend, or shows the whole world while nothing is
 *   plotted. Pan and zoom report the view (onViewChange), an opened or closed popup the selection
 *   (onSelect); a `view` or `selectedUid` that changes from outside (Back, a deep link) moves the map
 *   or opens that pin's popup.
 * - A new `focus` signal (header search) flies to the borehole and opens its popup.
 * - The screen unmounts on navigation; nothing is reported once the map is going away.
 */
import * as L from 'leaflet';
import { useEffect, useRef, type RefObject } from 'react';
import { osmTileLayer, removeMap } from '../../components/leaflet';
import type { BoreholeStatus } from '../../domain/types';
import { formatMapView, type MapView } from '../../routing/urlState';
import type { MapFocus } from '../../store/appStore';
import { pinColor } from '../../theme';
import styles from './BoreholeMap.module.css';
import {
  depthText,
  fitPadding,
  initialBounds,
  legendExtent,
  PIN_RADIUS,
  popupCrsWarning,
  WORLD_BOUNDS,
  WORLD_CENTER,
  WORLD_ZOOM,
  type PinRow,
} from './mapModel';
import { buildPopup } from './mapPopup';

/** Prototype timings: fly 60 ms after the request, open the popup once the 0.8 s flight is over. */
const FLY_DELAY_MS = 60;
const FLY_DURATION_S = 0.8;
const POPUP_DELAY_MS = 850;
/** Zoom of a deep link that selects a pin but names no view (as a search for one borehole). */
const SELECTED_ZOOM = 13;

/** The last search focus flown to, so coming back to the map doesn't fly again. */
let handledFocusNonce: number | null = null;

interface Props {
  /** The plotted boreholes, each with its status (mapRows). */
  pins: PinRow[];
  /** Drawn with the larger radius and on top (the borehole open in Review). */
  highlightUid: string | null;
  focus: MapFocus | null;
  /** The view the URL holds; null lets the map choose its first view. */
  view: MapView | null;
  /** The borehole whose popup is open (the URL's `sel`). */
  selectedUid: string | null;
  /** The REVIEW STATUS legend over the bottom-left corner: fitting the pins keeps them clear of it. */
  legendRef?: RefObject<HTMLElement | null>;
  onOpen(uid: string): void;
  /** Pan or zoom ended (also the first view). */
  onViewChange(view: MapView): void;
  /** A pin's popup opened (uid) or closed (null). */
  onSelect(uid: string | null): void;
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

const viewOf = (map: L.Map): MapView => {
  const c = map.getCenter();
  return { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
};

/** True while a search focus for this borehole waits for its flight (which opens the popup itself). */
const flying = (focus: MapFocus | null, uid: string | null) => !!focus && focus.uid === uid && focus.nonce !== handledFocusNonce;

export function BoreholeMap({ pins, highlightUid, focus, view, selectedUid, legendRef, onOpen, onViewChange, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef(new Map<string, L.CircleMarker>());
  /** The borehole whose popup is open on the map. */
  const openUid = useRef<string | null>(null);
  /** Set when the map is being removed: its last events are not reported. */
  const disposed = useRef(false);
  /** Latest props for Leaflet callbacks, which outlive a render. */
  const latest = useRef({ pins, onOpen, onViewChange, onSelect, view, selectedUid });
  useEffect(() => {
    latest.current = { pins, onOpen, onViewChange, onSelect, view, selectedUid };
  });

  // Create the map once, at the URL's view.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    disposed.current = false;
    const map = L.map(el, { scrollWheelZoom: true, zoomSnap: 0.25 });
    const { view: at, selectedUid: sel, pins: all } = latest.current;
    const selected = sel ? all.find((p) => p.uid === sel) : undefined;
    // The pins' bounds, or the whole world while nothing is plotted: no country is built in.
    const bounds = initialBounds(all);
    const world = bounds === WORLD_BOUNDS;
    if (at) map.setView([at.lat, at.lng], at.zoom);
    else if (selected) map.setView([selected.pin.lat, selected.pin.lng], SELECTED_ZOOM);
    else if (el.clientWidth > 0 && el.clientHeight > 0) {
      // No pin may start under the legend in the bottom-left corner (measured, else its CSS size).
      const box = el.getBoundingClientRect();
      const legend = legendExtent(box, legendRef?.current?.getBoundingClientRect() ?? null);
      const padding = fitPadding({ width: el.clientWidth, height: el.clientHeight }, legend);
      map.fitBounds(bounds, world ? {} : { ...padding, maxZoom: 13 });
    } else map.setView(world ? WORLD_CENTER : L.latLngBounds(bounds).getCenter(), world ? WORLD_ZOOM : 6);
    osmTileLayer().addTo(map);
    mapRef.current = map;

    // Every pan and zoom goes into the URL; the first view too, so a reload finds it.
    const report = () => {
      if (!disposed.current) latest.current.onViewChange(viewOf(map));
    };
    map.on('moveend', report);
    report();

    // Recompute the map size whenever the container changes size (first layout, window resize).
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(el);
    const markers = markersRef.current;

    return () => {
      disposed.current = true;
      resize.disconnect();
      removeMap(map);
      markers.clear();
      openUid.current = null;
      mapRef.current = null;
    };
  }, []);

  // Add, restyle, move and remove pins as the data changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    /** Popup content, built from the latest data each time the popup opens. */
    const popupFor = (uid: string): HTMLElement => {
      const { pins: all, onOpen: open } = latest.current;
      const p = all.find((x) => x.uid === uid);
      if (!p) return document.createElement('div');
      return buildPopup(
        {
          id: p.id,
          project: p.project,
          depth: depthText(p.depth),
          status: p.status,
          crsWarning: popupCrsWarning(p.crs),
        },
        // The popup stays selected in the URL, so Back to the map reopens it.
        () => open(uid),
      );
    };

    const markers = markersRef.current;
    const seen = new Set<string>();
    for (const p of pins) {
      seen.add(p.uid);
      const style = pinStyle(p.status, p.uid === highlightUid);
      const existing = markers.get(p.uid);
      if (existing) {
        existing.setLatLng([p.pin.lat, p.pin.lng]);
        existing.setStyle(style);
        if (existing.isPopupOpen()) existing.setPopupContent(popupFor(p.uid));
      } else {
        const uid = p.uid;
        const m = L.circleMarker([p.pin.lat, p.pin.lng], style).addTo(map);
        m.bindPopup(() => popupFor(uid));
        m.on('popupopen', () => {
          openUid.current = uid;
          if (!disposed.current) latest.current.onSelect(uid);
        });
        m.on('popupclose', () => {
          if (openUid.current === uid) openUid.current = null;
          if (!disposed.current) latest.current.onSelect(openUid.current);
        });
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
  }, [pins, highlightUid]);

  // A view from outside (Back, an edited URL) moves the map; the map's own reports come back equal.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !view || formatMapView(viewOf(map)) === formatMapView(view)) return;
    map.setView([view.lat, view.lng], view.zoom, { animate: false });
  }, [view]);

  // A selection from outside (Back, a deep link) opens that pin's popup, or closes the open one.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || selectedUid === openUid.current || flying(focus, selectedUid)) return;
    if (!selectedUid) map.closePopup();
    else markersRef.current.get(selectedUid)?.openPopup();
  }, [selectedUid, focus, pins]);

  // Fly to a searched borehole and open its popup (prototype fly()).
  useEffect(() => {
    if (!focus || focus.nonce === handledFocusNonce) return;
    const b = latest.current.pins.find((x) => x.uid === focus.uid);
    if (!b) {
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
        map.flyTo([b.pin.lat, b.pin.lng], focus.zoom, { duration: FLY_DURATION_S });
        timers.push(setTimeout(() => markersRef.current.get(b.uid)?.openPopup(), POPUP_DELAY_MS));
      }, FLY_DELAY_MS),
    );
    return () => timers.forEach(clearTimeout);
  }, [focus]);

  return <div ref={containerRef} className={styles.map} role="region" aria-label="Borehole map" />;
}
