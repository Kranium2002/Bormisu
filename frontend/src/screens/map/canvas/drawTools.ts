/**
 * Area selection with leaflet-geoman (FRONTEND.md F10): rectangle, polygon and circle, one area at a
 * time; and a planned line (geoman's Line mode, finished with a double-click or Enter), handed to
 * `onLine` as [lng, lat] points. Only one draw mode runs at a time (starting one ends the other). A finished shape becomes the contract's Area (mapModel.areaFromDrawn) and is handed to
 * `onArea` (the store's selectArea); geoman's own layer is removed at once, because the map draws
 * the selected area itself from the store (shapes.ts), so it stays while its result set is active
 * and goes with a reset. Escape cancels drawing (and only that: it does not also close a panel).
 *
 * Geoman (about 290 kB) is a chunk of its own, loaded when the map is created (off the first paint);
 * a draw tool clicked before it is there starts once it is. It is opted in per map: only maps
 * created with `pmIgnore: false` get it, so the other maps of the app and the thousands of pins get
 * no editing handlers. Snapping is off (it would test every pin).
 */
// The default import is the live Leaflet object the plugins extend (a namespace import is a copy taken before they ran).
import L from 'leaflet';
// Types only (geoman's augmentation of Leaflet's types); the code is loaded by loadGeoman().
import type {} from '@geoman-io/leaflet-geoman-free';
import type { Area } from '../../../domain/types';
import { COL } from '../../../theme';
import { areaFromDrawn, type DrawnLayer } from '../mapModel';

export type DrawShape = 'rectangle' | 'polygon' | 'circle' | 'line';

const PM_SHAPE: Record<DrawShape, string> = { rectangle: 'Rectangle', polygon: 'Polygon', circle: 'Circle', line: 'Line' };
const SHAPE_OF: Record<string, DrawShape> = { Rectangle: 'rectangle', Polygon: 'polygon', Circle: 'circle', Line: 'line' };

const LINE: L.PathOptions = { color: COL.dark, weight: 2, opacity: 0.9 };

let geoman: Promise<void> | null = null;

/** Loads leaflet-geoman once (it extends the global Leaflet) and opts every later map out of it by default. */
export function loadGeoman(): Promise<void> {
  geoman ??= Promise.all([import('@geoman-io/leaflet-geoman-free'), import('@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css')]).then(
    () => L.PM.setOptIn(true),
    (e: unknown) => {
      // A failed chunk load (offline) may succeed on the next try.
      geoman = null;
      throw e;
    },
  );
  return geoman;
}

/** Geoman's map handler class (not in its typings as a constructor). */
type PmMapClass = new (map: L.Map) => L.PM.PMMap;

export interface DrawToolsOptions {
  /** A shape was finished: its Area (never called for an unusable shape). */
  onArea(area: Area): void;
  /** A line was finished: its points as [lng, lat] (at least two). */
  onLine?(points: [number, number][]): void;
  /** Drawing started (the shape) or ended (null). */
  onMode(shape: DrawShape | null): void;
  /** The number of points of the line being drawn (0 when a line drawing starts). */
  onLinePoints?(count: number): void;
}

/** Geoman's Line draw handler: `_finishShape` is what a double-click or Enter runs (not in its typings). */
type PmLineDraw = { _finishShape?(): void };

/** The [lng, lat] points of a drawn polyline (a nested list of a multi-line is flattened). */
function lineFromDrawn(layer: L.Layer): [number, number][] {
  const raw = (layer as L.Polyline).getLatLngs?.() ?? [];
  const flat = (raw as unknown[]).flat(2) as L.LatLng[];
  return flat.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng)).map((p) => [p.lng, p.lat]);
}

export class DrawTools {
  private active: DrawShape | null = null;
  private destroyed = false;
  /** Resolves with the map's geoman handler once geoman is loaded; null when the tools are gone or it failed. */
  private readonly pm: Promise<L.PM.PMMap | null>;

  constructor(
    private readonly map: L.Map,
    private readonly o: DrawToolsOptions,
  ) {
    map.on('pm:drawstart', this.onStart);
    map.on('pm:drawend', this.onEnd);
    map.on('pm:create', this.onCreate);
    // Capture: Escape while drawing is handled here before the app's Escape (which closes panels).
    window.addEventListener('keydown', this.onKey, true);
    this.pm = loadGeoman().then(
      () => {
        if (this.destroyed) return null;
        // A map created before geoman was loaded has no handler yet: give it the one geoman's init hook gives.
        if (!map.pm) map.pm = new (L.PM as unknown as { Map: PmMapClass }).Map(map);
        map.pm.setGlobalOptions({ snappable: false, exitModeOnEscape: false });
        return map.pm;
      },
      (e: unknown) => {
        console.warn(`Map: the area tools could not be loaded (${e instanceof Error ? e.message : String(e)}).`);
        return null;
      },
    );
  }

  get shape(): DrawShape | null {
    return this.active;
  }

  /** Starts drawing a shape (ending a drawing in progress first); waits for geoman when it is still loading. */
  start(shape: DrawShape): void {
    void this.pm.then((pm) => {
      if (!pm || this.destroyed) return;
      pm.disableDraw();
      pm.enableDraw(PM_SHAPE[shape], {
        tooltips: false,
        continueDrawing: false,
        ...(shape === 'line' ? { finishOn: 'dblclick' as const } : {}),
        allowSelfIntersection: false,
        finishOnEnter: true,
        snappable: false,
        templineStyle: LINE,
        hintlineStyle: { ...LINE, dashArray: '5 5' },
        pathOptions: { ...LINE, fillColor: COL.dark, fillOpacity: 0.06 },
      });
    });
  }

  /** Finishes the line being drawn, as a double-click or Enter would (geoman ignores it below two points). */
  finish(): void {
    if (this.active !== 'line') return;
    (this.map.pm?.Draw as unknown as { Line?: PmLineDraw } | undefined)?.Line?._finishShape?.();
  }

  /** Ends drawing without a shape. */
  cancel(): void {
    const pm = this.map.pm;
    if (pm?.globalDrawModeEnabled()) pm.disableDraw();
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.map.off('pm:drawstart', this.onStart);
    this.map.off('pm:drawend', this.onEnd);
    this.map.off('pm:create', this.onCreate);
    this.cancel();
    this.destroyed = true;
    this.active = null;
  }

  private readonly onStart = (e: { shape: string; workingLayer?: L.Layer }) => {
    this.active = SHAPE_OF[e.shape] ?? null;
    this.o.onMode(this.active);
    if (this.active !== 'line') return;
    // The line's points so far (FINISH needs two); geoman fires pm:vertexadded on the layer being drawn.
    this.o.onLinePoints?.(0);
    const layer = e.workingLayer;
    layer?.on('pm:vertexadded', () => this.o.onLinePoints?.(lineFromDrawn(layer).length));
  };

  private readonly onEnd = () => {
    this.active = null;
    this.o.onMode(null);
  };

  private readonly onCreate = (e: { shape: string; layer: L.Layer }) => {
    if (e.shape === 'Line') {
      // The server's line replaces geoman's: its layer goes at once.
      const points = lineFromDrawn(e.layer);
      e.layer.remove();
      if (points.length >= 2) this.o.onLine?.(points);
      return;
    }
    const area = areaFromDrawn(e.shape, e.layer as unknown as DrawnLayer);
    e.layer.remove();
    if (area) this.o.onArea(area);
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !this.map.pm?.globalDrawModeEnabled()) return;
    e.preventDefault();
    e.stopPropagation();
    this.cancel();
  };
}
