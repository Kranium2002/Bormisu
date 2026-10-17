/**
 * Area selection with leaflet-geoman (FRONTEND.md F10): rectangle, polygon and circle, one area at a
 * time. A finished shape becomes the contract's Area (mapModel.areaFromDrawn) and is handed to
 * `onArea` (the store's selectArea); geoman's own layer is removed at once, because the map draws
 * the selected area itself from the store (shapes.ts), so it stays while its result set is active
 * and goes with a reset. Escape cancels drawing (and only that: it does not also close a panel).
 *
 * Geoman is opted in per map: only maps created with `pmIgnore: false` get it, so the other maps of
 * the app and the thousands of pins get no editing handlers. Snapping is off (it would test every pin).
 */
// The default import is the live Leaflet object the plugins extend (a namespace import is a copy taken before they ran).
import L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import type { Area } from '../../../domain/types';
import { COL } from '../../../theme';
import { areaFromDrawn, type DrawnLayer } from '../mapModel';

L.PM.setOptIn(true);

export type DrawShape = 'rectangle' | 'polygon' | 'circle';

const PM_SHAPE: Record<DrawShape, string> = { rectangle: 'Rectangle', polygon: 'Polygon', circle: 'Circle' };
const SHAPE_OF: Record<string, DrawShape> = { Rectangle: 'rectangle', Polygon: 'polygon', Circle: 'circle' };

const LINE: L.PathOptions = { color: COL.dark, weight: 2, opacity: 0.9 };

export interface DrawToolsOptions {
  /** A shape was finished: its Area (never called for an unusable shape). */
  onArea(area: Area): void;
  /** Drawing started (the shape) or ended (null). */
  onMode(shape: DrawShape | null): void;
}

export class DrawTools {
  private active: DrawShape | null = null;

  constructor(
    private readonly map: L.Map,
    private readonly o: DrawToolsOptions,
  ) {
    map.pm.setGlobalOptions({ snappable: false, exitModeOnEscape: false });
    map.on('pm:drawstart', this.onStart);
    map.on('pm:drawend', this.onEnd);
    map.on('pm:create', this.onCreate);
    // Capture: Escape while drawing is handled here before the app's Escape (which closes panels).
    window.addEventListener('keydown', this.onKey, true);
  }

  get shape(): DrawShape | null {
    return this.active;
  }

  /** Starts drawing a shape (ending a drawing in progress first). */
  start(shape: DrawShape): void {
    this.map.pm.disableDraw();
    this.map.pm.enableDraw(PM_SHAPE[shape], {
      tooltips: false,
      continueDrawing: false,
      allowSelfIntersection: false,
      finishOnEnter: true,
      snappable: false,
      templineStyle: LINE,
      hintlineStyle: { ...LINE, dashArray: '5 5' },
      pathOptions: { ...LINE, fillColor: COL.dark, fillOpacity: 0.06 },
    });
  }

  /** Ends drawing without a shape. */
  cancel(): void {
    if (this.map.pm.globalDrawModeEnabled()) this.map.pm.disableDraw();
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.map.off('pm:drawstart', this.onStart);
    this.map.off('pm:drawend', this.onEnd);
    this.map.off('pm:create', this.onCreate);
    this.cancel();
    this.active = null;
  }

  private readonly onStart = (e: { shape: string }) => {
    this.active = SHAPE_OF[e.shape] ?? null;
    this.o.onMode(this.active);
  };

  private readonly onEnd = () => {
    this.active = null;
    this.o.onMode(null);
  };

  private readonly onCreate = (e: { shape: string; layer: L.Layer }) => {
    const area = areaFromDrawn(e.shape, e.layer as unknown as DrawnLayer);
    e.layer.remove();
    if (area) this.o.onArea(area);
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !this.map.pm.globalDrawModeEnabled()) return;
    e.preventDefault();
    e.stopPropagation();
    this.cancel();
  };
}
