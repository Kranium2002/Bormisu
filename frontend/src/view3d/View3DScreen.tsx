/**
 * /3d: a 3D view of any borehole selection (a planned line's hits, an area drawn on the map, a search
 * result set, the LIST), drawn below a grey map of the site. Read-only: it shows what the records hold.
 *
 * - Each borehole is a column of its layers in their DIN 4023 colours (a faint "not logged" tail down
 *   to the final depth), standing below ground or at its ground level (by elevation).
 * - Groundwater readings are discs at their depth (filled: rest level or standpipe; open: strike); the
 *   readings of different boreholes are joined along a planned line, or as an interpolated surface.
 * - Optional: the ground surface and the rock head between boreholes, labels, the map, a depth scale.
 * - What is left out (no map position, no ground level, beyond the first 300) is said in numbers.
 *
 * The selection loads from the URL alone, as /report does (useReportData). The scene is plain numbers
 * (geometry.ts); deck.gl draws it (layers3d.ts) in a Deck created once per visit. Without WebGL2 the
 * stage says so calmly and the panel and legend stay. The stage's data-* attributes come from React
 * state, never from WebGL, so tests and screen readers can rely on them.
 */
import { Deck, MapView, type MapViewState, type PickingInfo } from '@deck.gl/core';
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { TILE_ATTRIBUTION, TILE_URL } from '../config';
import { dinEntry } from '../domain/din';
import { decimal } from '../domain/format';
import { K } from '../domain/keys';
import type { Area, Borehole, GroundwaterType } from '../domain/types';
import { useLang } from '../i18n';
import { canAlignByElevation } from '../report/combinedChart';
import { elevationDatum, isUnsure, orderedRecords, selectionFacts, type ReportSelection } from '../report/reportModel';
import { useReportData } from '../report/useReportData';
import { useLocationRoute } from '../routing/RouteSync';
import { mapPath, reportPath, type ReportUrlState } from '../routing/urlState';
import { cellOf, sheetT, type SheetLang } from '../screens/sheet/sheetModel';
import { useAppStore } from '../store/appStore';
import {
  buildScene,
  clamp,
  defaultExaggeration,
  EXAGGERATION_MIN,
  exaggerationMax,
  fitView,
  levelLabel,
  MAX_BOREHOLES,
  radiusOnScreen,
  toLocal,
  type Frame,
  type ScaleRing,
  type Scene,
  type SceneBorehole,
  type SceneSegment,
  type SceneWater,
  type Vec3,
  type VerticalMode,
} from './geometry';
import { labelsFit, layerGroup, layerGroups, metresPerPixel, ringStride, sceneLayers, type Camera, type Show, type WaterLink } from './layers3d';
import { Legend3D } from './Legend3D';
import styles from './View3D.module.css';

const NO_URL: ReportUrlState = { rs: null, line: null, buffer: null, unrev: null };

/** Boreholes up to which the ID labels start switched on. */
const LABELS_UP_TO = 40;
/** Narrow screens start with the panel folded away. */
const NARROW = '(max-width: 720px)';

type WebGlState = 'loading' | 'ready' | 'unavailable';

/** `t(text)` with {n} filled in. */
const fill = (text: string, n: number | string) => text.replace('{n}', String(n));

export function View3DScreen() {
  const route = useLocationRoute();
  const url = route.kind === 'view3d' ? route : NO_URL;
  const data = useReportData(url);
  const lang: SheetLang = useLang((s) => s.lang);
  const t = (en: string) => sheetT(lang, en);

  if (data.state === 'none') {
    return (
      <div className={styles.screen}>
        <EmptyState title="NO SELECTION" message="Open MAP and choose 3D VIEW for the boreholes the map shows. Or select boreholes first (an area, a planned line, a search, LIST), then choose 3D VIEW." />
      </div>
    );
  }
  if (data.state === 'error') {
    return (
      <div className={styles.screen}>
        <EmptyState tone="error" title="3D VIEW NOT AVAILABLE" message={`${t('The selection could not be loaded')}: ${data.message}`} />
      </div>
    );
  }
  if (data.state === 'loading') {
    return (
      <div className={styles.screen}>
        <div className={styles.loading} role="status" aria-live="polite">
          <p className={styles.loadingTitle}>{t('LOADING')}</p>
          <p>{data.total == null ? t('Loading the selection…') : `${t('Loading the boreholes…')} ${data.loaded} / ${data.total}`}</p>
        </div>
      </div>
    );
  }
  return <View3D url={url} selection={data.selection} records={data.records} missing={data.missing} lang={lang} />;
}

export default View3DScreen;

interface ViewProps {
  url: ReportUrlState;
  selection: ReportSelection;
  records: Borehole[];
  missing: number;
  lang: SheetLang;
}

/** True when the browser can make a WebGL2 context (the context is released again). */
function hasWebGL2(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const narrow = () => typeof window !== 'undefined' && !!window.matchMedia?.(NARROW).matches;

/**
 * The camera that shows the whole scene in a stage of this size, with the view's limits: fitView's
 * camera, aimed at the middle of the scene's height and backed off for a scene taller than it is wide
 * (columns standing at their ground level can be).
 */
function homeView(scene: Scene, el: HTMLElement | null): MapViewState {
  const { minZ, maxZ } = scene.extent;
  const tall = { ...scene, extent: { ...scene.extent, span: Math.max(scene.extent.span, maxZ - minZ) } };
  const fit = fitView(tall, { width: el?.clientWidth ?? 800, height: el?.clientHeight ?? 600 }) ?? { longitude: 10, latitude: 51, zoom: 4, pitch: 0, bearing: 0 };
  return { ...fit, position: [0, 0, (minZ + maxZ) / 2], maxPitch: 85, minZoom: 2, maxZoom: 22 };
}

/** The selection's own shapes on the ground: a planned line's path, an area's outline (scene metres, z = 0). */
function groundShapes(selection: ReportSelection, frame: Frame | null): { line: Vec3[][]; area: Vec3[][] } {
  if (!frame) return { line: [], area: [] };
  const at = (lng: number, lat: number): Vec3 => [...toLocal(frame, lng, lat), 0];
  if (selection.kind === 'line') return { line: selection.alignment.parts.map((p) => p.map(([lng, lat]) => at(lng, lat))), area: [] };
  if (selection.kind === 'area') return { line: [], area: areaOutline(selection.area, frame, at) };
  return { line: [], area: [] };
}

function areaOutline(a: Area, frame: Frame, at: (lng: number, lat: number) => Vec3): Vec3[][] {
  if (a.type === 'bbox') {
    const [w, s, e, n] = a.bbox;
    return [[at(w, s), at(e, s), at(e, n), at(w, n), at(w, s)]];
  }
  if (a.type === 'polygon') return a.polygon.coordinates.map((ring) => ring.map(([lng, lat]) => at(lng, lat)));
  const [cx, cy] = toLocal(frame, a.center[0], a.center[1]);
  const ring: Vec3[] = [];
  for (let i = 0; i <= 72; i++) {
    const r = (i / 72) * 2 * Math.PI;
    ring.push([cx + a.radiusM * Math.cos(r), cy + a.radiusM * Math.sin(r), 0]);
  }
  return [ring];
}

/** The camera in coarse steps, so the text and the column width are rebuilt only now and then while it moves. */
function roughCamera(v: Pick<MapViewState, 'latitude' | 'zoom' | 'pitch'>): Camera {
  return { latitude: Math.round(v.latitude), zoom: Math.round(v.zoom * 8) / 8, pitch: Math.round((v.pitch ?? 0) / 5) * 5 };
}

const sameCamera = (a: Camera, b: Camera) => a.latitude === b.latitude && a.zoom === b.zoom && a.pitch === b.pitch;

/** What a plain mouse drag does: move the ground (as on the map) or turn and tilt the view. */
type DragMode = 'pan' | 'rotate';
const DRAG_KEY = 'bormisu.view3d.drag';

/** The drag mode chosen last in this browser; moving, like the map, when none was. */
function storedDrag(): DragMode {
  try {
    return localStorage.getItem(DRAG_KEY) === 'rotate' ? 'rotate' : 'pan';
  } catch {
    return 'pan';
  }
}

/** The controller's options: the other drag (right button, or with Ctrl / Shift) does what the plain one doesn't. */
const controllerOf = (drag: DragMode) => ({ dragMode: drag, keyboard: true, inertia: reducedMotion() ? 0 : 250 });

/** A compass bearing in (-180, 180]. */
const wrapBearing = (b: number) => ((((b + 180) % 360) + 360) % 360) - 180 || 0;

/** Steps of the on-screen controls: zoom levels, degrees of turn, degrees of tilt. */
const ZOOM_STEP = 0.5;
const TURN_STEP = 15;
const TILT_STEP = 10;
/** The side view's tilt: nearly level, so the columns read as a section. */
const SIDE_PITCH = 80;

const metres = (v: number) => `${decimal(v, 2)} m`;

const WATER_TYPE: Record<GroundwaterType, string> = {
  rest: 'rest level',
  standpipe: 'standpipe reading',
  strike: 'water strike',
  other: 'other groundwater reading',
};

/** Tooltip text of a picked object. Plain text only: IDs and descriptions come from uploaded documents. */
function tooltipText(info: PickingInfo, records: ReadonlyMap<string, Borehole>, lang: SheetLang, t: (en: string) => string): string | null {
  if (!info.object || !info.layer) return null;
  const group = layerGroup(info.layer.id);
  if (group === 'columns') {
    const s = info.object as SceneSegment;
    const lines = [`${s.id} · ${decimal(s.from, 2)}–${decimal(s.to, 2)} m`];
    if (s.kind === 'notLogged') {
      lines.push(t('not logged'));
      return lines.join('\n');
    }
    const e = dinEntry(s.din);
    lines.push(s.din ? `${s.din} ${e ? (lang === 'de' ? e.nameDe : e.nameEn) : t('unknown code')}` : t('no DIN code in the record'));
    const b = records.get(s.uid);
    const layer = b?.layers.find((l) => l.n === s.n);
    const text = layer ? layer.lithologyAsPrinted || layer.lithology : '';
    if (text) lines.push(text);
    const value = b?.values.find((v) => v.key === K.lithology(s.n));
    if (value && cellOf(lang, value).unreviewed) lines.push(`* ${t('not reviewed yet')}`);
    if (isUnsure(value)) lines.push(`? ${t('low confidence or flagged')}`);
    return lines.join('\n');
  }
  if (group === 'water-markers') {
    const w = info.object as SceneWater;
    const b = records.get(w.uid);
    // The reading as the record states it: its own depth and elevation, nothing worked out.
    const r = b?.groundwater.find((g) => g.type === w.type && g.raw === w.raw && g.date === w.date);
    const lines = [w.id, t(WATER_TYPE[w.type])];
    const depth = r ? r.depth : w.depth;
    if (depth != null) lines.push(`${metres(depth)} ${t('below ground')}`);
    if (r && r.elevation != null) {
      const datum = b ? elevationDatum(b) : null;
      lines.push(levelLabel(decimal(r.elevation, 2), datum));
    }
    if (w.date) lines.push(w.date);
    return lines.join('\n');
  }
  if (group === 'labels' || group === 'collars') {
    const b = info.object as SceneBorehole;
    return `${b.id}\n${t('Final depth')}: ${metres(b.depth)}`;
  }
  return null;
}

/** The detail screen of a picked borehole (its layer for a column). */
function clickTarget(info: PickingInfo): { uid: string; layer: number | null } | null {
  if (!info.object || !info.layer) return null;
  const group = layerGroup(info.layer.id);
  if (group === 'columns') {
    const s = info.object as SceneSegment;
    return { uid: s.uid, layer: s.kind === 'layer' ? s.n : null };
  }
  if (group === 'water-markers' || group === 'labels' || group === 'collars') return { uid: (info.object as SceneWater | SceneBorehole).uid, layer: null };
  return null;
}

const TOOLTIP_STYLE: Partial<CSSStyleDeclaration> = {
  backgroundColor: '#111',
  color: '#fff',
  fontSize: '12px',
  lineHeight: '1.4',
  fontFamily: 'var(--font-sans)',
  padding: '8px 10px',
  borderRadius: '4px',
  maxWidth: '320px',
  whiteSpace: 'pre-line',
  overflowWrap: 'anywhere',
};

function View3D({ url, selection, records, missing, lang }: ViewProps) {
  const t = (en: string) => sheetT(lang, en);
  const ordered = useMemo(() => orderedRecords(selection, records), [selection, records]);
  const title = useMemo(() => selectionFacts(lang, selection, ordered.length).subtitle, [lang, selection, ordered.length]);
  const recordOf = useMemo(() => new Map(ordered.map((b) => [b.uid, b])), [ordered]);
  const kind = selection.kind;

  const canElevate = useMemo(() => canAlignByElevation(ordered.filter((b) => b.onMap && b.lat != null && b.lng != null)), [ordered]);
  // It starts below ground: the map is the ground of every borehole, which needs no explaining. By
  // elevation the flat map can only lie at one level (the lowest ground level), so boreholes on higher
  // ground start above it; that view is a switch away and says where the map lies.
  const [mode, setMode] = useState<VerticalMode>('depth');
  // The exaggeration follows the site (a third as tall as it is wide) until the slider is moved.
  const autoExaggeration = useMemo(() => {
    const s = buildScene(ordered, { mode, exaggeration: 1, kind });
    return defaultExaggeration(s.extent.span, s.extent.maxZ - s.extent.minZ);
  }, [ordered, mode, kind]);
  const [chosen, setChosen] = useState<number | null>(null);
  const exaggeration = chosen ?? autoExaggeration;
  const scene = useMemo(() => buildScene(ordered, { mode, exaggeration, kind }), [ordered, mode, exaggeration, kind]);

  const [show, setShow] = useState<Show>(() => ({
    boreholes: true,
    water: true,
    ground: false,
    rock: false,
    labels: scene.counts.drawn <= LABELS_UP_TO,
    basemap: true,
    scale: true,
    link: kind === 'line' ? 'line' : 'surface',
  }));
  const link: WaterLink = show.link === 'surface' && !scene.waterSurface ? 'line' : show.link;
  const groundOk = scene.mode === 'elevation' && !!scene.groundSurface;
  const shown: Show = { ...show, link, ground: show.ground && groundOk, rock: show.rock && !!scene.rockSurface };
  const set = (patch: Partial<Show>) => setShow((s) => ({ ...s, ...patch }));

  const shapes = useMemo(() => groundShapes(selection, scene.frame), [selection, scene.frame]);
  const scaleLabel = (r: ScaleRing) => levelLabel(decimal(r.value, r.value % 1 ? 1 : 0), scene.mode === 'elevation' ? scene.datum : null);
  // The camera, coarsely (zoom in quarter steps, pitch in 5° steps): the text follows it.
  const [cam, setCam] = useState<Camera>(() => roughCamera(homeView(scene, null)));
  const stride = ringStride(scene, cam);
  const fit = labelsFit(scene, cam);
  // Column width follows the zoom: visible from afar, apart from its neighbours close up.
  const radius = radiusOnScreen(scene, metresPerPixel(cam));
  const layers = useMemo(
    () => sceneLayers({ scene, show: shown, tileTemplate: TILE_URL, plannedLine: shapes.line, areaOutline: shapes.area, scaleLabel, ringStride: stride, labelsFit: fit, radius }),
    // `shown` and `scaleLabel` follow from these (a new object each render, so they aren't listed).
    [scene, shapes, shown.boreholes, shown.water, shown.ground, shown.rock, shown.labels, shown.basemap, shown.scale, shown.link, stride, fit, radius],
  );
  const groups = layerGroups(layers);

  // The Deck: created once, fed new layers when they change, finalized on leaving.
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<Deck<MapView> | null>(null);
  const [webgl, setWebgl] = useState<WebGlState>('loading');
  const label = `${t('3D view')}: ${title}, ${fill(t('{n} boreholes drawn'), scene.counts.drawn)}`;
  const [drag, setDrag] = useState<DragMode>(storedDrag);
  const latest = useRef({ layers, scene, recordOf, lang, t, label, drag });
  latest.current = { layers, scene, recordOf, lang, t, label, drag };

  // The camera: deck.gl is told where to look (a controlled view), so the buttons can move it too.
  const viewRef = useRef<MapViewState | null>(null);
  const [bearing, setBearing] = useState(0);
  /** Notes where the camera is: coarsely for the text and the column width, and its bearing for the compass. */
  const track = (v: MapViewState) => {
    const next = roughCamera(v);
    setCam((c) => (sameCamera(c, next) ? c : next));
    const b = Math.round(v.bearing ?? 0);
    setBearing((x) => (x === b ? x : b));
  };
  /** Points the camera. */
  const aim = (v: MapViewState) => {
    viewRef.current = v;
    deckRef.current?.setProps({ viewState: v });
    track(v);
  };
  /** Moves the camera by a step (the on-screen buttons). */
  const nudge = (d: { zoom?: number; bearing?: number; pitch?: number }) => {
    const v = viewRef.current;
    if (!v) return;
    aim({
      ...v,
      zoom: clamp(v.zoom + (d.zoom ?? 0), v.minZoom ?? 2, v.maxZoom ?? 22),
      bearing: wrapBearing((v.bearing ?? 0) + (d.bearing ?? 0)),
      pitch: clamp((v.pitch ?? 0) + (d.pitch ?? 0), 0, v.maxPitch ?? 85),
    });
  };
  /** Turns the camera to a named view, where it stands. */
  const face = (to: { pitch?: number; bearing?: number }) => {
    const v = viewRef.current;
    if (v) aim({ ...v, ...to });
  };
  const changeDrag = (d: DragMode) => {
    setDrag(d);
    deckRef.current?.setProps({ controller: controllerOf(d) });
    try {
      localStorage.setItem(DRAG_KEY, d);
    } catch {
      // not remembered, still switched
    }
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!hasWebGL2()) {
      setWebgl('unavailable');
      return;
    }
    let alive = true;
    let started = false;
    let deck: Deck<MapView> | null = null;
    const fail = () => {
      if (alive) setWebgl('unavailable');
    };
    const follow = (v: MapViewState) => {
      viewRef.current = v;
      if (alive) track(v);
    };
    const create = () => {
      const start = homeView(latest.current.scene, stageRef.current);
      follow(start);
      try {
        deck = new Deck<MapView>({
          parent: host,
          // Below-ground columns lie beyond MapView's usual far plane at a low pitch: push it out.
          views: new MapView({ repeat: false, farZMultiplier: 50 }),
          viewState: start,
          controller: controllerOf(latest.current.drag),
          onViewStateChange: ({ viewState }) => {
            deck?.setProps({ viewState });
            follow(viewState as MapViewState);
          },
          layers: latest.current.layers,
          getTooltip: (info) => {
            const { recordOf: recs, lang: l, t: tt } = latest.current;
            const text = tooltipText(info, recs, l, tt);
            return text ? { text, style: TOOLTIP_STYLE } : null;
          },
          getCursor: ({ isDragging, isHovering }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'),
          onClick: (info) => {
            const to = clickTarget(info);
            if (to) useAppStore.getState().showRoute({ kind: 'detail', uid: to.uid, layer: to.layer });
          },
          onLoad: () => {
            started = true;
            // The canvas is the deck's own once its GPU device exists.
            const canvas = deck?.getCanvas();
            if (canvas) {
              canvas.setAttribute('role', 'img');
              canvas.setAttribute('aria-label', latest.current.label);
              canvas.tabIndex = 0;
            }
            if (alive) setWebgl('ready');
          },
          onError: (error, layer) => {
            // A map tile that doesn't load leaves a gap in the map, nothing more.
            if (layer && layerGroup(layer.id) === 'basemap') {
              console.warn('3D view: a map tile could not be loaded', error?.message);
              return;
            }
            // Before the first frame: WebGL2 couldn't start.
            if (!started) {
              fail();
              return;
            }
            console.warn('3D view:', error?.message);
          },
        });
      } catch {
        fail();
        return;
      }
      deckRef.current = deck;
    };
    // One frame later: React StrictMode's throwaway first mount is gone by then and never makes a Deck
    // (Deck only takes its canvas back once its GPU device exists).
    const frame = requestAnimationFrame(create);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      deckRef.current = null;
      (deck as Deck<MapView> | null)?.finalize();
      host.replaceChildren();
    };
  }, []);

  useEffect(() => {
    deckRef.current?.setProps({ layers });
  }, [layers]);

  useEffect(() => {
    deckRef.current?.getCanvas()?.setAttribute('aria-label', label);
  }, [label]);

  // The home camera again: on RESET VIEW (which also gives the exaggeration back to the site) and when
  // the vertical axis changes, since the scene then stands elsewhere. Applied once the scene is rebuilt.
  const [home, setHome] = useState(0);
  useEffect(() => {
    if (home === 0) return;
    aim(homeView(latest.current.scene, stageRef.current));
    // `aim` only reads refs and state setters, so it is not a dependency.
  }, [home]);
  const resetView = () => {
    setChosen(null);
    setHome((n) => n + 1);
  };
  const changeMode = (m: VerticalMode) => {
    setMode(m);
    // By elevation the collars leave the map: the ground between them is shown, so they hang from it.
    if (m === 'elevation') set({ ground: true });
    setHome((n) => n + 1);
  };

  // Panel.
  const [panelOpen, setPanelOpen] = useState(() => !narrow());
  const panelId = useId();
  const name = useId();
  const c = scene.counts;
  const notes: string[] = [];
  if (c.eligible > c.drawn) {
    const text = t(kind === 'line' ? 'Showing the first {max} of {n} boreholes by chainage' : 'Showing the first {max} of {n} boreholes');
    notes.push(fill(text.replace('{max}', String(MAX_BOREHOLES)), c.eligible));
  }
  if (c.noPosition > 0) notes.push(fill(t('{n} without a map position are not shown'), c.noPosition));
  if (c.noGroundLevel > 0) notes.push(fill(t('{n} without a ground level are drawn at the reference level and left out of the surfaces'), c.noGroundLevel));
  if (c.noGroundwater > 0) notes.push(fill(t('{n} without a groundwater reading'), c.noGroundwater));
  if (missing > 0) notes.push(fill(t('{n} of the selection could not be loaded'), missing));
  const interpolated = (n: number) => <p className={styles.reason}>{fill(t('interpolated between {n} boreholes (display only, not stored)'), n)}</p>;

  return (
    <div className={styles.screen} data-screen-label="3D view">
      <div className={styles.toolbar}>
        <Link className={styles.back} to={mapPath({ at: null, sel: null, rs: selection.resultSet?.id ?? null })}>
          {t('‹ BACK')}
        </Link>
        <h1 className={styles.toolbarTitle}>{title}</h1>
        <Link className={styles.toolbarLink} to={reportPath(url)} data-testid="export-report">
          {t('EXPORT REPORT')}
        </Link>
      </div>

      <div
        ref={stageRef}
        className={styles.stage}
        data-testid="view3d"
        data-webgl={webgl}
        data-mode={scene.mode}
        data-boreholes={c.drawn}
        data-columns={scene.segments.length}
        data-water={link}
        data-layers={groups.join(' ')}
        data-panel={panelOpen ? 'open' : 'closed'}
        data-drag={drag}
        data-zoom={cam.zoom}
        data-pitch={cam.pitch}
        data-bearing={bearing}
      >
        <div ref={hostRef} className={styles.deck} />

        {webgl === 'ready' && scene.frame && (
          <div className={styles.nav} role="group" aria-label={t('Move the view')}>
            <NavButton label={t('Zoom in')} onStep={(s) => nudge({ zoom: ZOOM_STEP * s })}>
              <path d="M8 3v10M3 8h10" />
            </NavButton>
            <NavButton label={t('Zoom out')} onStep={(s) => nudge({ zoom: -ZOOM_STEP * s })}>
              <path d="M3 8h10" />
            </NavButton>
            <span className={styles.navGap} />
            <NavButton label={t('Turn left')} onStep={(s) => nudge({ bearing: -TURN_STEP * s })}>
              <path d="M3.6 8.2a4.4 4.4 0 1 0 1.5-3.5" />
              <path d="M2.9 2.6v3h3" />
            </NavButton>
            <NavButton label={t('Turn right')} onStep={(s) => nudge({ bearing: TURN_STEP * s })}>
              <path d="M12.4 8.2a4.4 4.4 0 1 1-1.5-3.5" />
              <path d="M13.1 2.6v3h-3" />
            </NavButton>
            <span className={styles.navGap} />
            <NavButton label={t('Look more from above')} onStep={(s) => nudge({ pitch: -TILT_STEP * s })}>
              <path d="M3.5 10l4.5-4.5 4.5 4.5" />
            </NavButton>
            <NavButton label={t('Look more from the side')} onStep={(s) => nudge({ pitch: TILT_STEP * s })}>
              <path d="M3.5 6l4.5 4.5 4.5-4.5" />
            </NavButton>
            <span className={styles.navGap} />
            <button type="button" className={styles.navButton} aria-label={t('Face north')} title={t('Face north')} onClick={() => face({ bearing: 0 })}>
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" style={{ transform: `rotate(${-bearing}deg)` }}>
                <path d="M8 1.5l3 6.5H5z" fill="var(--c-red)" />
                <path d="M8 14.5l3-6.5H5z" fill="var(--c-border-strong)" />
              </svg>
            </button>
          </div>
        )}

        {webgl === 'unavailable' && (
          <div className={styles.notice} role="status">
            <p className={styles.noticeTitle}>{t('3D NOT AVAILABLE')}</p>
            <p>{t('This browser cannot draw the 3D view (WebGL2 is not available).')}</p>
          </div>
        )}
        {webgl !== 'unavailable' && !scene.frame && (
          <div className={styles.notice} role="status">
            <p className={styles.noticeTitle}>{t('NOTHING TO DRAW')}</p>
            <p>{t('No borehole of the selection has a map position.')}</p>
          </div>
        )}

        <section className={styles.panel} aria-label={t('3D view settings')}>
          <button type="button" className={styles.panelToggle} aria-expanded={panelOpen} aria-controls={panelId} onClick={() => setPanelOpen((o) => !o)}>
            {t('LAYERS')} <span aria-hidden="true">{panelOpen ? '▴' : '▾'}</span>
          </button>
          <div id={panelId} hidden={!panelOpen} className={styles.panelBody}>
            <fieldset className={styles.group}>
              <legend className={styles.groupTitle}>{t('Show')}</legend>
              <Check label={t('Boreholes')} checked={show.boreholes} onChange={(v) => set({ boreholes: v })} />
              <Check label={t('Groundwater readings')} checked={show.water} onChange={(v) => set({ water: v })} />
              <Check
                label={t('Ground surface')}
                checked={shown.ground}
                disabled={!groundOk}
                onChange={(v) => set({ ground: v })}
                note={
                  scene.mode !== 'elevation' ? (
                    <p className={styles.reason}>{t('only by elevation')}</p>
                  ) : !scene.groundSurface ? (
                    <p className={styles.reason}>{t('needs at least 3 boreholes with a ground level')}</p>
                  ) : shown.ground ? (
                    interpolated(scene.groundSurface.boreholes)
                  ) : null
                }
              />
              <Check
                label={t('Rock head')}
                checked={shown.rock}
                disabled={!scene.rockSurface}
                onChange={(v) => set({ rock: v })}
                note={
                  !scene.rockSurface ? (
                    <p className={styles.reason}>{t('needs at least 3 boreholes with a rock head')}</p>
                  ) : shown.rock ? (
                    interpolated(scene.rockSurface.boreholes)
                  ) : null
                }
              />
              <Check label={t('Labels')} checked={show.labels} onChange={(v) => set({ labels: v })} />
              <Check label={t('Basemap')} checked={show.basemap} onChange={(v) => set({ basemap: v })} />
              <Check label={t('Depth scale')} checked={show.scale} onChange={(v) => set({ scale: v })} />
            </fieldset>

            <fieldset className={styles.group}>
              <legend className={styles.groupTitle}>{t('Groundwater link')}</legend>
              <div className={styles.radios}>
                {(['off', 'line', 'surface'] as const).map((v) => (
                  <label key={v} className={styles.radio}>
                    <input type="radio" name={`${name}-link`} value={v} checked={link === v} disabled={v === 'surface' && !scene.waterSurface} onChange={() => set({ link: v })} />
                    {t(v === 'off' ? 'Off' : v === 'line' ? 'Line' : 'Surface')}
                  </label>
                ))}
              </div>
              {!scene.waterSurface && <p className={styles.reason}>{t('Surface needs at least 3 boreholes with a reading')}</p>}
              {link === 'surface' && scene.waterSurface && interpolated(scene.waterSurface.boreholes)}
            </fieldset>

            <fieldset className={styles.group}>
              <legend className={styles.groupTitle}>{t('Vertical exaggeration')}</legend>
              <div className={styles.range}>
                <input
                  type="range"
                  min={EXAGGERATION_MIN}
                  max={Math.max(exaggerationMax(autoExaggeration), scene.exaggeration)}
                  step={1}
                  value={scene.exaggeration}
                  aria-label={t('Vertical exaggeration')}
                  aria-valuetext={`×${scene.exaggeration}`}
                  onChange={(e) => setChosen(Number(e.target.value))}
                />
                <output className={styles.rangeValue} data-testid="view3d-exaggeration">
                  ×{scene.exaggeration}
                </output>
              </div>
            </fieldset>

            <fieldset className={styles.group} disabled={!canElevate}>
              <legend className={styles.groupTitle}>{t('Vertical axis')}</legend>
              <div className={styles.radios}>
                {(['depth', 'elevation'] as const).map((m) => (
                  <label key={m} className={styles.radio}>
                    <input type="radio" name={`${name}-mode`} value={m} checked={scene.mode === m} onChange={() => changeMode(m)} />
                    {t(m === 'depth' ? 'BELOW GROUND' : 'BY ELEVATION')}
                  </label>
                ))}
              </div>
              {!canElevate && <p className={styles.reason}>{t('Fewer than two boreholes state a ground level')}</p>}
              {scene.mode === 'elevation' && scene.base != null && (
                <p className={styles.reason} data-testid="view3d-map-level">
                  {fill(t('The flat map lies at the lowest ground level, {n}. Boreholes on higher ground start above it.'), levelLabel(decimal(scene.base, 1), scene.datum))}
                </p>
              )}
            </fieldset>

            <fieldset className={styles.group}>
              <legend className={styles.groupTitle}>{t('Mouse drag')}</legend>
              <div className={styles.radios}>
                {(['pan', 'rotate'] as const).map((d) => (
                  <label key={d} className={styles.radio}>
                    <input type="radio" name={`${name}-drag`} value={d} checked={drag === d} onChange={() => changeDrag(d)} />
                    {t(d === 'pan' ? 'MOVES' : 'ROTATES')}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className={styles.views}>
              <button type="button" className={styles.reset} onClick={resetView} disabled={webgl !== 'ready'}>
                {t('RESET VIEW')}
              </button>
              <button type="button" className={styles.reset} onClick={() => face({ pitch: 0, bearing: 0 })} disabled={webgl !== 'ready'}>
                {t('TOP')}
              </button>
              <button type="button" className={styles.reset} onClick={() => face({ pitch: SIDE_PITCH })} disabled={webgl !== 'ready'}>
                {t('SIDE')}
              </button>
            </div>
            <p className={styles.help}>
              {t(
                drag === 'pan'
                  ? 'Drag to move · right-drag or Ctrl+drag to rotate · scroll to zoom'
                  : 'Drag to rotate · right-drag or Ctrl+drag to move · scroll to zoom',
              )}
            </p>
          </div>
          {notes.length > 0 && (
            <ul className={styles.notes} aria-label={t('Not shown')}>
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </section>

        <Legend3D scene={scene} show={shown} lang={lang} t={t} />

        {shown.basemap && scene.frame && (
          // The tile source's own attribution (build-time config, never record text).
          <div className={styles.attribution} dangerouslySetInnerHTML={{ __html: TILE_ATTRIBUTION }} />
        )}
      </div>
    </div>
  );
}

/**
 * A button of the on-screen camera controls: one step on a press, then smaller steps for as long as it
 * is held (so holding turns smoothly). Enter or Space on it is one step.
 */
function NavButton({ label, onStep, children }: { label: string; onStep(scale: number): void; children: ReactNode }) {
  const timer = useRef<number | null>(null);
  const step = useRef(onStep);
  step.current = onStep;
  const stop = () => {
    if (timer.current == null) return;
    // One id space for timeouts and intervals: either call clears whichever is running.
    window.clearTimeout(timer.current);
    window.clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  const press = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    stop();
    step.current(1);
    timer.current = window.setTimeout(() => {
      // About 45° of turn, 30° of tilt or one and a half zoom levels a second.
      timer.current = window.setInterval(() => step.current(0.12), 40);
    }, 350);
  };
  return (
    <button
      type="button"
      className={styles.navButton}
      aria-label={label}
      title={label}
      onPointerDown={press}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      // A pointer press already stepped; the keyboard's click has no pointer (detail 0).
      onClick={(e) => {
        if (e.detail === 0) onStep(1);
      }}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

function Check({ label, checked, disabled, onChange, note }: { label: string; checked: boolean; disabled?: boolean; onChange(v: boolean): void; note?: ReactNode }) {
  return (
    <div className={styles.check}>
      <label className={disabled ? styles.disabled : undefined}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
      {note}
    </div>
  );
}
