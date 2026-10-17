/**
 * The Leaflet map of the Map screen: the world map (FRONTEND.md F9), area selection (F10) and the
 * fly-to with outlines of place search and result sets (F11). React owns the container; Leaflet owns
 * everything inside it, driven through refs (canvas/: pins and clusters, draw tools, shapes, motion).
 *
 * Props (unchanged from round 1, so MapScreen needs no change):
 * - `pins`: the plotted boreholes with their status (mapModel.mapRows); `highlightUid`: drawn larger
 *   (the borehole open in Review); `focus`: header search's fly-to signal; `view` / `selectedUid`:
 *   the URL's `at` and `sel`; `legendRef`: the legend over the bottom-left corner, kept clear when
 *   fitting; `onOpen` (DETAIL), `onViewChange` (pan and zoom end), `onSelect` (popup opened / closed).
 * Everything else comes from the stores, so no further prop is needed:
 * - the colour mode (canvas/colourMode, switched in MapLegend): pins and cluster rings by status or
 *   by depth class;
 * - the active result set (filters, a drawn area, the URL's `rs`, later the chat): its members are
 *   highlighted, the other pins dimmed; its area (or the area being drawn while its request runs)
 *   is shown; RESET (clearResultSet) removes it;
 * - `mapOutline` (a result set's fit, a place, a fit_bounds): flies to its bbox with 48 px padding
 *   (instant under prefers-reduced-motion) and draws the dashed outline when asked; a new search or
 *   a reset removes the outline;
 * - drawing a rectangle, polygon or circle calls the store's selectArea with the contract's Area;
 *   while the chat asks for an area (chatAreaRequest, request_area) the shape goes to the chat
 *   instead (setChatArea: context.map_view of the next message): the map shows the chat's prompt
 *   as a hint and starts the rectangle tool, and shows the area drawn until the message is sent;
 * - the popup's REVIEW (openReview) and SOURCE (the final depth's Source panel, after ensureBorehole)
 *   with the reasons when they are off.
 *
 * Views: the map starts at `view` (the URL's `at`); without one at the selected pin, else fitted to
 * the pins clear of the legend, else on the whole world (no country is built in); it fits the pins
 * once when they arrive after an empty start. A selection from outside (the results table, Back, a
 * deep link) shows the pin, zooming out of its cluster (zoomToShowLayer), and opens its popup.
 *
 * The root carries what the map shows as data attributes (`data-pins`, `data-pins-drawn`,
 * `data-pins-in-view`, `data-members`, `data-colour-by`, `data-ready`): pins are canvas drawings,
 * not elements, so the e2e suites read these. The screen unmounts on navigation; nothing is reported
 * once the map is going away, and the map is removed with removeMap (after a chunked pin load).
 */
import * as L from 'leaflet';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { osmTileLayer, removeMap } from '../../components/leaflet';
import { ChatAreaHint } from '../../components/chat/ChatAreaHint';
import { K } from '../../domain/keys';
import { formatMapView, type MapView } from '../../routing/urlState';
import { useAppStore, type AppState, type MapFocus } from '../../store/appStore';
import styles from './BoreholeMap.module.css';
import { MAP_MAX_ZOOM } from './canvas/clusterOptions';
import { useColourMode } from './canvas/colourMode';
import { DrawToolbar } from './canvas/DrawToolbar';
import { DrawTools, type DrawShape } from './canvas/drawTools';
import { flyToBbox, FLY_DURATION_S, prefersReducedMotion } from './canvas/motion';
import { PinLayer } from './canvas/pinLayer';
import { MapShapes } from './canvas/shapes';
import {
  FIT_MARGIN,
  fitPadding,
  initialBounds,
  legendExtent,
  onlyArea,
  popupView,
  RESULT_FIT_MARGIN,
  WORLD_BOUNDS,
  WORLD_CENTER,
  WORLD_ZOOM,
  type PinRow,
} from './mapModel';
import { buildPopup } from './mapPopup';

/** Fly 60 ms after a search (the map screen may only just have been laid out). */
const FLY_DELAY_MS = 60;
/** Zoom of a deep link that selects a pin but names no view (as a search for one borehole). */
const SELECTED_ZOOM = 13;
/** The pins' canvas pane: above the overlay pane (drawn areas, outlines), below markers and popups. */
const PIN_PANE = 'pins';
const PIN_PANE_Z = '450';

/** The last search focus flown to, so coming back to the map doesn't fly again. */
let handledFocusNonce: number | null = null;
/** The last map outline flown to (same reason). */
let handledOutlineNonce: number | null = null;
/** An outline removed by a reset or a new search stays removed when the map comes back. */
let dismissedOutlineNonce: number | null = null;

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
  /** The legend over the bottom-left corner: fitting the pins keeps them clear of it. */
  legendRef?: RefObject<HTMLElement | null>;
  onOpen(uid: string): void;
  /** Pan or zoom ended (also the first view). */
  onViewChange(view: MapView): void;
  /** A pin's popup opened (uid) or closed (null). */
  onSelect(uid: string | null): void;
}

const viewOf = (map: L.Map): MapView => {
  const c = map.getCenter();
  return { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
};

/** True while a search focus for this borehole waits for its flight (which opens the popup itself). */
const flying = (focus: MapFocus | null, uid: string | null) => !!focus && focus.uid === uid && focus.nonce !== handledFocusNonce;

/** True when the filter panel was just reset (clearResultSet): the reset filter, no result set. */
const wasReset = (s: AppState, prev: AppState) =>
  s.filter !== prev.filter && !s.resultSet && !s.resultSetBusy && s.filter.area === null && onlyArea(s.filter);

export function BoreholeMap({ pins, highlightUid, focus, view, selectedUid, legendRef, onOpen, onViewChange, onSelect }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const pinsRef = useRef<PinLayer | null>(null);
  const shapesRef = useRef<MapShapes | null>(null);
  const drawRef = useRef<DrawTools | null>(null);
  /** The borehole whose popup is open on the map. */
  const openUid = useRef<string | null>(null);
  /** The pin a reveal (flight, cluster zoom) is on its way to. */
  const revealing = useRef<string | null>(null);
  /** The map started on the world because nothing was plotted: fit the pins once they come. */
  const awaitingPins = useRef(false);
  /** The view moved since the first one (a user, a flight): no automatic fit any more. */
  const moved = useRef(false);
  /** Set when the map is being removed: its last events are not reported. */
  const disposed = useRef(false);
  /** Refreshes the open popup (data arrived); set by the map effect. */
  const refreshPopup = useRef<() => void>(() => undefined);
  /** Latest props for Leaflet callbacks, which outlive a render. */
  const latest = useRef({ pins, onOpen, onViewChange, onSelect, view, selectedUid, legendRef });
  useEffect(() => {
    latest.current = { pins, onOpen, onViewChange, onSelect, view, selectedUid, legendRef };
  });

  const [drawMode, setDrawMode] = useState<DrawShape | null>(null);
  const colourBy = useColourMode((s) => s.colourBy);
  const resultSet = useAppStore((s) => s.resultSet);
  const resultSetBusy = useAppStore((s) => s.resultSetBusy);
  const filterArea = useAppStore((s) => s.filter.area);
  const mapOutline = useAppStore((s) => s.mapOutline);
  const chatAreaRequest = useAppStore((s) => s.chatAreaRequest);
  const chatArea = useAppStore((s) => s.chatArea);
  const members = useMemo(() => (resultSet ? new Set(resultSet.uids) : null), [resultSet]);
  // An area drawn for the chat (until its message is sent), else the area being selected while its
  // request runs, else the active result set's (none after a reset).
  const areaShown = chatArea ?? (resultSetBusy && filterArea ? filterArea : (resultSet?.area ?? null));

  // Create the map once, at the URL's view.
  useEffect(() => {
    const parent = hostRef.current;
    const root = rootRef.current;
    if (!parent || !root) return;
    disposed.current = false;
    moved.current = false;
    const reduced = prefersReducedMotion();
    // Leaflet gets an element of its own: a map still finishing its pin load can be removed later
    // while a new one (StrictMode, a quick return) already lives in the container.
    const el = document.createElement('div');
    el.className = styles.leaflet;
    parent.append(el);
    const map = L.map(el, {
      scrollWheelZoom: true,
      zoomSnap: 0.25,
      minZoom: 1,
      maxZoom: MAP_MAX_ZOOM,
      worldCopyJump: true,
      zoomAnimation: !reduced,
      fadeAnimation: !reduced,
      markerZoomAnimation: !reduced,
      // leaflet-geoman is opted in per map (canvas/drawTools): this one draws areas.
      pmIgnore: false,
    });
    map.createPane(PIN_PANE).style.zIndex = PIN_PANE_Z;

    /** Space the legend takes in the bottom-left corner (measured, else its CSS size). */
    const legendSize = () => legendExtent(el.getBoundingClientRect(), latest.current.legendRef?.current?.getBoundingClientRect() ?? null);
    const mapSize = () => ({ width: el.clientWidth, height: el.clientHeight });

    const { view: at, selectedUid: sel, pins: all } = latest.current;
    const selected = sel ? all.find((p) => p.uid === sel) : undefined;
    // The pins' bounds, or the whole world while nothing is plotted: no country is built in.
    const bounds = initialBounds(all);
    const world = bounds === WORLD_BOUNDS;
    if (at) map.setView([at.lat, at.lng], at.zoom);
    else if (selected) map.setView([selected.pin.lat, selected.pin.lng], SELECTED_ZOOM);
    else if (el.clientWidth > 0 && el.clientHeight > 0) map.fitBounds(bounds, world ? {} : { ...fitPadding(mapSize(), legendSize()), maxZoom: 13 });
    else map.setView(world ? WORLD_CENTER : L.latLngBounds(bounds).getCenter(), world ? WORLD_ZOOM : 6);
    awaitingPins.current = world && !at && !selected;
    // The basemap first: the cluster group reads the map's zoom range when it is added.
    osmTileLayer().addTo(map);

    /** What the map shows, on the root for the e2e suites (pins are canvas drawings, not elements). */
    const stats = () => {
      const layer = pinsRef.current;
      if (!layer || disposed.current) return;
      const s = layer.stats();
      root.dataset.pins = String(s.pins);
      root.dataset.pinsDrawn = String(s.drawn);
      root.dataset.pinsInView = String(s.inView);
      root.dataset.members = String(s.members);
      root.dataset.ready = String(!s.loading);
    };

    const actions = (uid: string) => ({
      onDetail: () => latest.current.onOpen(uid),
      onReview: () => useAppStore.getState().openReview(uid),
      onSource: () => {
        // The Source panel needs the record (cached by now: the popup loaded it when it opened).
        void useAppStore
          .getState()
          .ensureBorehole(uid)
          .then((b) => {
            if (b) useAppStore.getState().openSource(uid, K.finalDepth);
          });
      },
    });
    let popupKey = '';
    const popupContent = (uid: string): HTMLElement => {
      const row = pinsRef.current?.row(uid);
      if (!row) return document.createElement('div');
      const s = useAppStore.getState();
      const v = popupView(row, s.boreholes.find((b) => b.uid === uid), s.recordLoads[uid]);
      popupKey = JSON.stringify(v);
      return buildPopup(v, actions(uid));
    };
    refreshPopup.current = () => {
      const uid = openUid.current;
      const popup = uid ? pinsRef.current?.openPopupOf(uid) : null;
      const row = uid ? pinsRef.current?.row(uid) : undefined;
      if (!uid || !popup || !row) return;
      const s = useAppStore.getState();
      const v = popupView(row, s.boreholes.find((b) => b.uid === uid), s.recordLoads[uid]);
      // Rebuilt only when something it shows changed (a rebuild would drop the focus inside it).
      if (JSON.stringify(v) !== popupKey) popup.setContent(popupContent(uid));
    };

    const layer = new PinLayer(map, {
      pane: PIN_PANE,
      reducedMotion: reduced,
      classes: { icon: styles.cluster, dimmed: styles.clusterDimmed, member: styles.clusterMember, ring: styles.clusterRing, label: styles.clusterLabel },
      popupContent,
      popupOptions: { maxWidth: 280, autoPanPaddingTopLeft: [20, 20], autoPanPaddingBottomRight: [64, 20] },
      onPopupOpen: (uid) => {
        if (disposed.current) return;
        openUid.current = uid;
        latest.current.onSelect(uid);
        // REVIEW and SOURCE need the full record: fetched now, the popup updates when it is here.
        void useAppStore.getState().ensureBorehole(uid);
      },
      onPopupClose: (uid) => {
        if (openUid.current === uid) openUid.current = null;
        if (!disposed.current) latest.current.onSelect(openUid.current);
      },
      onChange: stats,
    });
    const shapes = new MapShapes(map);
    const draw = new DrawTools(map, {
      onArea: (area) => {
        const s = useAppStore.getState();
        // request_area: the shape is the chat's (context.map_view of the next message), not a selection.
        if (s.chatAreaRequest) {
          s.setChatArea(area);
          s.openChat();
          return;
        }
        void s.selectArea(area);
      },
      onMode: (shape) => {
        if (!disposed.current) setDrawMode(shape);
      },
    });
    mapRef.current = map;
    pinsRef.current = layer;
    shapesRef.current = shapes;
    drawRef.current = draw;

    // Every pan and zoom goes into the URL; the first view too, so a reload finds it.
    const report = () => {
      if (disposed.current) return;
      latest.current.onViewChange(viewOf(map));
      stats();
    };
    map.on('moveend', report);
    report();
    map.on('movestart', () => {
      moved.current = true;
    });

    // Recompute the map size whenever the container changes size (first layout, window resize).
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(el);

    const dismissOutline = () => {
      const o = useAppStore.getState().mapOutline;
      if (o) dismissedOutlineNonce = o.nonce;
      shapes.setOutline(null);
    };
    const unsubscribe = useAppStore.subscribe((s, prev) => {
      if (openUid.current && (s.boreholes !== prev.boreholes || s.recordLoads !== prev.recordLoads)) refreshPopup.current();
      // RESET, a dropped result set or a new place search takes the dashed outline away.
      if ((prev.resultSet && !s.resultSet) || (s.placeBusy && !prev.placeBusy) || wasReset(s, prev)) dismissOutline();
    });

    return () => {
      disposed.current = true;
      unsubscribe();
      resize.disconnect();
      draw.destroy();
      shapes.destroy();
      refreshPopup.current = () => undefined;
      openUid.current = null;
      revealing.current = null;
      mapRef.current = null;
      pinsRef.current = null;
      shapesRef.current = null;
      drawRef.current = null;
      el.remove();
      // After a chunked pin load still running (its next chunk would need the map).
      layer.dispose(() => removeMap(map));
    };
  }, []);

  // Add, restyle, move and remove pins as the data changes.
  useEffect(() => {
    const layer = pinsRef.current;
    const map = mapRef.current;
    if (!layer || !map) return;
    layer.sync(pins);
    refreshPopup.current();
    // After an empty start the first pins are fitted once, unless the view was moved meanwhile.
    if (awaitingPins.current && pins.length && !moved.current) {
      awaitingPins.current = false;
      const el = map.getContainer();
      const legend = legendExtent(el.getBoundingClientRect(), latest.current.legendRef?.current?.getBoundingClientRect() ?? null);
      map.fitBounds(initialBounds(pins), { ...fitPadding({ width: el.clientWidth, height: el.clientHeight }, legend, FIT_MARGIN), maxZoom: 13, animate: false });
    }
  }, [pins]);

  useEffect(() => {
    pinsRef.current?.setHighlight(highlightUid);
  }, [highlightUid]);

  useEffect(() => {
    pinsRef.current?.setColourBy(colourBy);
  }, [colourBy]);

  // The active result set: members highlighted, the rest dimmed.
  useEffect(() => {
    pinsRef.current?.setMembers(members);
  }, [members]);

  useEffect(() => {
    shapesRef.current?.setArea(areaShown);
  }, [areaShown]);

  // request_area: the rectangle tool starts with the chat's hint; a cancelled request ends the drawing.
  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;
    if (chatAreaRequest) draw.start('rectangle');
    else draw.cancel();
  }, [chatAreaRequest]);

  // A bbox to fly to (a result set's fit, a place), with its dashed outline when asked.
  useEffect(() => {
    const map = mapRef.current;
    const shapes = shapesRef.current;
    if (!map || !shapes || !mapOutline) return;
    if (mapOutline.nonce !== handledOutlineNonce) {
      handledOutlineNonce = mapOutline.nonce;
      awaitingPins.current = false;
      const el = map.getContainer();
      const legend = legendExtent(el.getBoundingClientRect(), latest.current.legendRef?.current?.getBoundingClientRect() ?? null);
      flyToBbox(map, mapOutline.bbox, fitPadding({ width: el.clientWidth, height: el.clientHeight }, legend, RESULT_FIT_MARGIN));
    }
    shapes.setOutline(mapOutline.outline && mapOutline.nonce !== dismissedOutlineNonce ? mapOutline.bbox : null);
  }, [mapOutline]);

  // A view from outside (Back, an edited URL) moves the map; the map's own reports come back equal.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !view || formatMapView(viewOf(map)) === formatMapView(view)) return;
    map.setView([view.lat, view.lng], view.zoom, { animate: false });
  }, [view]);

  // A selection from outside (the results table, Back, a deep link) shows the pin and opens its
  // popup, or closes the open one.
  useEffect(() => {
    const map = mapRef.current;
    const layer = pinsRef.current;
    if (!map || !layer || selectedUid === openUid.current || flying(focus, selectedUid)) return;
    if (!selectedUid) {
      revealing.current = null;
      map.closePopup();
      return;
    }
    if (revealing.current === selectedUid || !layer.has(selectedUid)) return;
    revealing.current = selectedUid;
    const uid = selectedUid;
    layer.reveal(uid, { animate: !prefersReducedMotion(), duration: FLY_DURATION_S }, () => {
      if (revealing.current === uid) revealing.current = null;
      if (!disposed.current && latest.current.selectedUid === uid) layer.openPopup(uid);
    });
  }, [selectedUid, focus, pins]);

  // Fly to a searched borehole and open its popup.
  useEffect(() => {
    if (!focus || focus.nonce === handledFocusNonce) return;
    if (!pinsRef.current?.has(focus.uid)) {
      handledFocusNonce = focus.nonce;
      return;
    }
    const timer = setTimeout(() => {
      const map = mapRef.current;
      const layer = pinsRef.current;
      if (!map || !layer) return;
      // Marked handled only once the flight starts, so StrictMode's effect re-run still flies.
      handledFocusNonce = focus.nonce;
      map.closePopup();
      map.invalidateSize();
      revealing.current = focus.uid;
      layer.reveal(focus.uid, { zoom: focus.zoom, animate: !prefersReducedMotion(), duration: FLY_DURATION_S }, () => {
        if (revealing.current === focus.uid) revealing.current = null;
        if (!disposed.current) layer.openPopup(focus.uid);
      });
    }, FLY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [focus]);

  const removeArea = () => {
    drawRef.current?.cancel();
    const s = useAppStore.getState();
    // The area drawn for the chat goes alone (the selection, if any, stays).
    if (s.chatArea) {
      s.setChatArea(null);
      return;
    }
    // Only an area selected: that is a reset. With other filters, the selection runs again without the area.
    if (onlyArea(s.filter)) s.clearResultSet();
    else {
      s.setFilter({ area: null });
      void s.applyFilter();
    }
  };

  return (
    <div ref={rootRef} className={styles.root} role="region" aria-label="Borehole map" data-colour-by={colourBy}>
      <div ref={hostRef} className={styles.host} />
      <DrawToolbar
        mode={drawMode}
        areaShown={areaShown != null}
        onDraw={(shape) => drawRef.current?.start(shape)}
        onCancel={() => drawRef.current?.cancel()}
        onRemoveArea={removeArea}
      />
      {chatAreaRequest && (
        <ChatAreaHint
          prompt={chatAreaRequest.prompt}
          drawing={drawMode !== null}
          onDraw={() => drawRef.current?.start('rectangle')}
          onCancel={() => useAppStore.getState().cancelChatAreaRequest()}
        />
      )}
    </div>
  );
}
