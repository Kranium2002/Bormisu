/**
 * The Leaflet map of the Map screen (prototype initMap / fly). Leaflet is driven directly through
 * refs: React owns the container, Leaflet owns everything inside it.
 *
 * - One circle marker per plotted borehole, coloured by review status and restyled in place when a
 *   status, a position or the highlighted borehole changes.
 * - Clicking a pin opens a popup with OPEN DETAIL ›.
 * - `view` is the map focus (focusLayers.ts). World: no mask, no limits, fitted to every pin. Country:
 *   mask + border, fitted to the country, can't pan away or zoom out beyond it. A new focus replaces
 *   mask, border and limits; the same focus with moved pins only updates the limits.
 * - A new `fly` signal (header search) flies to the borehole and opens its popup. MapScreen passes
 *   it only once the borehole is one of this map's pins (after switching the focus if needed).
 * - `me` (MY LOCATION) is a blue dot with its accuracy circle, both non-interactive; a new fix flies
 *   there (zoom 15) once `flyToMe` says the focus is settled. `locateControl` is rendered into a
 *   Leaflet control under the zoom buttons.
 * - App unmounts the screen on navigation, so the view is kept in a module variable and restored
 *   when the focus is still the same.
 */
import * as L from 'leaflet';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { osmTileLayer, removeMap } from '../../components/leaflet';
import type { BoreholeStatus } from '../../domain/types';
import type { Country } from '../../geo/countries';
import type { LatLngBox } from '../../geo/polygon';
import type { FlyTarget } from '../../store/appStore';
import { COL, pinColor } from '../../theme';
import styles from './BoreholeMap.module.css';
import {
  clearCountryLimits,
  countryLayers,
  createFocusRenderer,
  fitCountry,
  fitMinZoom,
  fitWorld,
  setCountryLimits,
} from './focusLayers';
import { depthText, PIN_RADIUS, popupCrsWarning, type PlottedBorehole } from './mapModel';
import { buildPopup } from './mapPopup';

/** Prototype timings: fly 60 ms after the request, open the popup once the 0.8 s flight is over. */
const FLY_DELAY_MS = 60;
const FLY_DURATION_S = 0.8;
const POPUP_DELAY_MS = 850;
/** Street level for MY LOCATION. */
const ME_ZOOM = 15;
/** MY LOCATION panes: the accuracy circle under the pins (overlay pane 400), the dot above them. */
const ME_ACCURACY_PANE = 'bormisuMeAccuracy';
const ME_DOT_PANE = 'bormisuMe';

/** The user's position as the map draws it. */
export interface MeMarker {
  lat: number;
  lng: number;
  accuracyM: number;
  simulated: boolean;
  /** Changes with every new fix. */
  nonce: number;
}

/** What the map shows (MapScreen derives it from the store's map focus). */
export type MapView =
  /** Every pin; `pins` is their bounding box (null without pins: the whole world). */
  | { kind: 'world'; key: string; pins: LatLngBox | null }
  /** One country; `box` is its main territory plus every pin in it. */
  | { kind: 'country'; key: string; country: Country; box: LatLngBox }
  /** A country focus whose outlines are still loading: no pins, the view stays where it is. */
  | { kind: 'pending'; key: string };

/** Last map view and the focus it belongs to, kept across screen changes (the screen unmounts). */
let savedView: { center: L.LatLngTuple; zoom: number; key: string } | null = null;
/** The last search target flown to, so coming back to the map doesn't fly again. */
let handledFlyNonce: number | null = null;
/** The last MY LOCATION fix flown to. */
let handledMeNonce: number | null = null;

interface Props {
  /** The pins of the current focus. */
  boreholes: PlottedBorehole[];
  statuses: Map<string, BoreholeStatus>;
  /** Drawn with the larger radius and on top (the borehole open in Review). */
  highlightUid: string | null;
  view: MapView;
  /** Search target among `boreholes`, else null. */
  fly: FlyTarget | null;
  /** MY LOCATION position, or null. */
  me: MeMarker | null;
  /** True once the focus fits `me` (MapScreen switched it if needed): a new fix flies there. */
  flyToMe: boolean;
  /**
   * Pixels to keep the position left of the map centre after the fly, so a panel over the right side
   * (NEAR YOU) doesn't hide it. 0 centres it.
   */
  meOffsetPx: number;
  /** Content of the control under the zoom buttons (MY LOCATION). */
  locateControl: ReactNode;
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

/** Leaflet objects of the focus: mask + border, their renderer, and which view they show. */
interface FocusState {
  layers: L.LayerGroup;
  renderer: L.Renderer;
  /** `${kind}:${key}` of the applied view, null before the first. */
  applied: string | null;
}

/** Leaflet objects of MY LOCATION: dot + accuracy circle and their renderers. */
interface MeState {
  layers: L.LayerGroup;
  accuracyRenderer: L.Renderer;
  dotRenderer: L.Renderer;
}

function createMePanes(map: L.Map): MeState {
  const accuracyPane = map.createPane(ME_ACCURACY_PANE);
  accuracyPane.style.zIndex = '390';
  const dotPane = map.createPane(ME_DOT_PANE);
  dotPane.style.zIndex = '450';
  return {
    layers: L.layerGroup().addTo(map),
    accuracyRenderer: L.svg({ pane: ME_ACCURACY_PANE }),
    dotRenderer: L.svg({ pane: ME_DOT_PANE }),
  };
}

/** An empty Leaflet control under the zoom buttons; React renders into its element. Clicks stay off the map. */
function createControl(map: L.Map): HTMLElement {
  const el = L.DomUtil.create('div', 'leaflet-control');
  L.DomEvent.disableClickPropagation(el);
  L.DomEvent.disableScrollPropagation(el);
  const control = new L.Control({ position: 'topleft' });
  control.onAdd = () => el;
  control.addTo(map);
  return el;
}

export function BoreholeMap({ boreholes, statuses, highlightUid, view, fly, me, flyToMe, meOffsetPx, locateControl, onOpen }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const focusRef = useRef<FocusState | null>(null);
  const meRef = useRef<MeState | null>(null);
  const [controlEl, setControlEl] = useState<HTMLElement | null>(null);
  const markersRef = useRef(new Map<string, L.CircleMarker>());
  /** Latest props for Leaflet callbacks, which outlive a render. */
  const latest = useRef({ boreholes, statuses, view, onOpen });
  useEffect(() => {
    latest.current = { boreholes, statuses, view, onOpen };
  });

  // Create the map once; keep its view when the screen unmounts.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const map = L.map(el, { scrollWheelZoom: true, zoomSnap: 0.25, maxBoundsViscosity: 1 });
    map.setView([30, 10], 2, { animate: false }); // replaced by the focus effect right below
    osmTileLayer().addTo(map);
    focusRef.current = { layers: L.layerGroup().addTo(map), renderer: createFocusRenderer(map), applied: null };
    meRef.current = createMePanes(map);
    setControlEl(createControl(map));
    mapRef.current = map;

    // Recompute the map size whenever the container changes size (first layout, window resize),
    // and with it the smallest zoom at which the whole focus country still fits.
    const resize = new ResizeObserver(() => {
      map.invalidateSize();
      const v = latest.current.view;
      if (v.kind === 'country') fitMinZoom(map, v.box);
    });
    resize.observe(el);
    const markers = markersRef.current;

    return () => {
      resize.disconnect();
      const v = latest.current.view;
      const c = map.getCenter();
      savedView = v.kind === 'pending' ? null : { center: [c.lat, c.lng], zoom: map.getZoom(), key: v.key };
      removeMap(map);
      markers.clear();
      mapRef.current = null;
      focusRef.current = null;
      meRef.current = null;
      setControlEl(null);
    };
  }, []);

  // Apply the focus: mask, border, limits and the fitted view. Runs before the pin and fly effects.
  useEffect(() => {
    const map = mapRef.current;
    const focus = focusRef.current;
    if (!map || !focus) return;
    const id = `${view.kind}:${view.key}`;
    if (focus.applied === id) {
      // Same focus, but its box may have grown (a pin moved after a CRS confirmation).
      if (view.kind === 'country') setCountryLimits(map, view.box);
      return;
    }
    const first = focus.applied === null;
    focus.applied = id;
    focus.layers.clearLayers();
    // Lift the old limits first: a small country's minimum zoom would stop the fit to a larger one.
    clearCountryLimits(map);
    const saved = first && savedView?.key === view.key ? savedView : null;
    if (view.kind === 'country') {
      for (const layer of countryLayers(view.country, focus.renderer)) focus.layers.addLayer(layer);
      if (saved) map.setView(saved.center, saved.zoom, { animate: false });
      else fitCountry(map, view.box);
      setCountryLimits(map, view.box);
    } else if (view.kind === 'world') {
      if (saved) map.setView(saved.center, saved.zoom, { animate: false });
      else fitWorld(map, view.pins);
    }
  }, [view]);

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
    if (!fly || fly.nonce === handledFlyNonce) return;
    const b = latest.current.boreholes.find((x) => x.uid === fly.uid);
    if (!b) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(
      setTimeout(() => {
        const map = mapRef.current;
        if (!map) return;
        // Marked handled only once the flight starts, so StrictMode's effect re-run still flies.
        handledFlyNonce = fly.nonce;
        map.closePopup();
        map.invalidateSize();
        map.flyTo([b.lat, b.lng], fly.zoom, { duration: FLY_DURATION_S });
        timers.push(setTimeout(() => markersRef.current.get(b.uid)?.openPopup(), POPUP_DELAY_MS));
      }, FLY_DELAY_MS),
    );
    return () => timers.forEach(clearTimeout);
  }, [fly]);

  // MY LOCATION: redraw the dot and the accuracy circle for every new position.
  useEffect(() => {
    const layers = meRef.current;
    if (!layers) return;
    layers.layers.clearLayers();
    if (!me) return;
    const at: L.LatLngTuple = [me.lat, me.lng];
    L.circle(at, {
      renderer: layers.accuracyRenderer,
      pane: ME_ACCURACY_PANE,
      radius: me.accuracyM,
      color: COL.gw,
      weight: 1,
      opacity: 0.6,
      fillColor: COL.gw,
      fillOpacity: 0.12,
      interactive: false,
      className: 'bormisu-me-accuracy',
    }).addTo(layers.layers);
    const dot = L.circleMarker(at, {
      renderer: layers.dotRenderer,
      pane: ME_DOT_PANE,
      radius: 7,
      color: '#fff',
      weight: 2.5,
      fillColor: COL.gw,
      fillOpacity: 1,
      interactive: false,
      className: 'bormisu-me-dot',
    }).addTo(layers.layers);
    if (me.simulated) {
      dot.bindTooltip('SIMULATED LOCATION', { permanent: true, direction: 'right', offset: [10, 0], className: styles.meLabel }).openTooltip();
    }
  }, [me]);

  // MY LOCATION: fly to a new fix once the focus fits it.
  useEffect(() => {
    if (!me || !flyToMe || me.nonce === handledMeNonce) return;
    const timer = setTimeout(() => {
      const map = mapRef.current;
      if (!map) return;
      handledMeNonce = me.nonce;
      map.closePopup();
      map.invalidateSize();
      // Centre the map that far right of the position, at the target zoom, so the position ends up left of centre.
      const offset = Math.min(meOffsetPx, map.getSize().x / 4);
      const centre = map.unproject(map.project([me.lat, me.lng], ME_ZOOM).add([offset, 0]), ME_ZOOM);
      map.flyTo(centre, ME_ZOOM, { duration: FLY_DURATION_S });
    }, FLY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [me, flyToMe, meOffsetPx]);

  return (
    <>
      <div ref={containerRef} className={styles.map} role="region" aria-label="Borehole map" />
      {controlEl && createPortal(locateControl, controlEl)}
    </>
  );
}
