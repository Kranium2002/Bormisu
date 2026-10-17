/**
 * The borehole pins of the map (FRONTEND.md F9): one circle marker per plotted borehole, drawn on a
 * canvas renderer of its own pane, clustered with leaflet.markercluster (clusterOptions.ts).
 *
 * - Pins are added once and then updated in place: a new colour (status, depth class, result-set
 *   emphasis) restyles the marker, a moved pin is taken out and put back (markercluster places a pin
 *   when it is added), a borehole that left the map layer is removed.
 * - Cluster icons show the count and, as ring segments, the mix of statuses or depth classes of their
 *   pins; with a result set active, clusters without a member are dimmed.
 * - Adding thousands of pins is chunked by markercluster; until it is done (`loading`) new data waits
 *   and reveals are queued, and the layer is disposed only after it (a chunk running on a removed
 *   map would throw).
 * - Cluster icons are not in the tab order: the results table under the map is the keyboard path to
 *   every borehole (FRONTEND.md section 6).
 */
// The default import is the live Leaflet object the plugins extend (a namespace import is a copy taken before they ran).
import L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import { clusterView, colourClassOf, emphasisOf, pinStyle, type ColourBy, type PinRow } from '../mapModel';
import { clusterOptions } from './clusterOptions';

// Clusters are Leaflet markers, which are focusable buttons by default: not these (see above).
(L.MarkerCluster as unknown as { mergeOptions(o: L.MarkerOptions): void }).mergeOptions({ keyboard: false });

/** markercluster internals read here (not in its typings): the zoom a cluster stands for, a pin's deepest cluster. */
interface ClusterInternals {
  _zoom?: number;
}
interface MarkerInternals {
  __parent?: ClusterInternals;
}
interface GroupInternals {
  _topClusterLevel?: ClusterInternals;
  /** Cluster split / merge animations running (zoomToShowLayer waits for none). */
  _inZoomAnimation?: number;
  /** Runs the queued end of a cluster animation and clears its timer. */
  _processQueue?(): void;
}

/** CSS classes of a cluster icon (CSS-module names from the map's stylesheet). */
export interface ClusterClasses {
  icon: string;
  dimmed: string;
  member: string;
  ring: string;
  label: string;
}

export interface PinLayerOptions {
  /** Map pane of the pins' canvas (above the overlay pane with the drawn areas). */
  pane: string;
  reducedMotion: boolean;
  classes: ClusterClasses;
  /** Popup content of a pin, built when it opens. */
  popupContent(uid: string): HTMLElement;
  popupOptions: L.PopupOptions;
  onPopupOpen(uid: string): void;
  onPopupClose(uid: string): void;
  /** What the layer shows changed (pins added, restyled, clusters re-split): for the map's counts. */
  onChange(): void;
}

/** What the map shows, for its data attributes (and the e2e suites). */
export interface PinStats {
  /** Pins in the layer. */
  pins: number;
  /** Pins drawn on their own (not inside a cluster). */
  drawn: number;
  /** Pins whose position is inside the current view (drawn or in a cluster). */
  inView: number;
  /** Members of the active result set among the pins (0 without one). */
  members: number;
  loading: boolean;
}

/**
 * Leaflet's canvas renderer can leave an animation frame behind: a synchronous redraw (a view reset,
 * e.g. map.stop() during teardown) clears its request id while a requested frame is still pending,
 * so removing the renderer cannot cancel that frame, which then draws on the removed canvas
 * ("Cannot read properties of undefined (reading 'save')"). This renderer skips a redraw once its
 * canvas is gone.
 */
const PinCanvas = L.Canvas.extend({
  _redraw(this: { _ctx?: CanvasRenderingContext2D }) {
    if (this._ctx) (L.Canvas.prototype as unknown as { _redraw(): void })._redraw.call(this);
  },
}) as unknown as new (options?: L.RendererOptions) => L.Canvas;

/** What makes a pin's colour or emphasis: compared to restyle only the pins that changed. */
const paintKey = (r: PinRow) => `${r.status}|${r.depth}`;

export class PinLayer {
  private readonly group: L.MarkerClusterGroup;
  private readonly renderer: L.Canvas;
  private readonly markers = new Map<string, L.CircleMarker>();
  private readonly rows = new Map<string, PinRow>();
  private readonly uids = new WeakMap<L.Layer, string>();
  private colourBy: ColourBy = 'status';
  private members: ReadonlySet<string> | null = null;
  private highlight: string | null = null;
  /** addLayers calls whose chunks are still running. */
  private loads = 0;
  private idle: (() => void)[] = [];
  /** The newest pins handed over while a load was running. */
  private queued: PinRow[] | null = null;
  private disposed = false;
  /** Bumped by every reveal and by a drag: an older reveal's pending steps then do nothing. */
  private revealToken = 0;
  /** The pending last step of the running reveal (after its flight). */
  private pendingFinish: (() => void) | null = null;

  constructor(
    private readonly map: L.Map,
    private readonly o: PinLayerOptions,
  ) {
    this.renderer = new PinCanvas({ pane: o.pane, padding: 0.5 });
    this.group = L.markerClusterGroup({
      ...clusterOptions(o.reducedMotion),
      chunkProgress: (done, total) => {
        if (done >= total) this.loaded();
      },
      iconCreateFunction: (cluster) => this.clusterIcon(cluster),
    });
    this.group.on('animationend', () => o.onChange());
    this.group.addTo(map);
    // A drag during a flight to a pin ends that reveal: the map stays where the user takes it.
    map.on('dragstart', this.cancelReveal);
  }

  /** True while chunks of pins are still being added. */
  get loading(): boolean {
    return this.loads > 0;
  }

  /** Runs `f` once no pins are being added (at once when none are). */
  whenIdle(f: () => void): void {
    if (this.loads === 0) f();
    else this.idle.push(f);
  }

  has(uid: string): boolean {
    return this.markers.has(uid);
  }

  /** The row of a pin as last synced. */
  row(uid: string): PinRow | undefined {
    return this.rows.get(uid);
  }

  /** Adds, restyles, moves and removes pins to match `pins`. */
  sync(pins: PinRow[]): void {
    if (this.disposed) return;
    if (this.loads > 0) {
      this.queued = pins;
      return;
    }
    const add: L.CircleMarker[] = [];
    const remove: L.CircleMarker[] = [];
    const restyled: L.CircleMarker[] = [];
    const seen = new Set<string>();
    for (const p of pins) {
      if (seen.has(p.uid)) continue;
      seen.add(p.uid);
      const prev = this.rows.get(p.uid);
      this.rows.set(p.uid, p);
      const m = this.markers.get(p.uid);
      if (!m) {
        add.push(this.createMarker(p));
      } else if (!prev || prev.pin.lat !== p.pin.lat || prev.pin.lng !== p.pin.lng) {
        this.group.removeLayer(m);
        m.setLatLng([p.pin.lat, p.pin.lng]);
        m.setStyle(this.styleOf(p));
        add.push(m);
      } else if (paintKey(prev) !== paintKey(p)) {
        m.setStyle(this.styleOf(p));
        restyled.push(m);
      }
    }
    for (const [uid, m] of this.markers) {
      if (seen.has(uid)) continue;
      remove.push(m);
      this.markers.delete(uid);
      this.rows.delete(uid);
    }
    if (remove.length) this.group.removeLayers(remove);
    // markercluster takes any pins here (its typings say Marker): it only walks their parent clusters.
    if (restyled.length) this.group.refreshClusters(restyled as unknown as L.Marker[]);
    if (add.length) {
      // Chunked: loaded() runs when the last chunk is in (at once for a small batch).
      this.loads += 1;
      this.group.addLayers(add, true);
    } else {
      this.o.onChange();
    }
  }

  /** Colours every pin and cluster ring by status or by depth class. */
  setColourBy(colourBy: ColourBy): void {
    if (colourBy === this.colourBy) return;
    this.colourBy = colourBy;
    this.restyleAll();
  }

  /** Highlights the members of the active result set and dims the other pins; null shows every pin normally. */
  setMembers(members: ReadonlySet<string> | null): void {
    if (members === this.members || (!members && !this.members)) return;
    this.members = members;
    this.restyleAll();
  }

  /** Draws one pin larger and on top (the borehole open in Review); null for none. */
  setHighlight(uid: string | null): void {
    if (uid === this.highlight) return;
    const before = this.highlight;
    this.highlight = uid;
    for (const id of [before, uid]) {
      const m = id ? this.markers.get(id) : undefined;
      const r = id ? this.rows.get(id) : undefined;
      if (m && r) m.setStyle(this.styleOf(r));
    }
    const m = uid ? this.markers.get(uid) : undefined;
    if (m && this.map.hasLayer(m)) m.bringToFront();
  }

  /**
   * Shows a pin and then runs `then` (e.g. opens its popup): when it is inside a cluster or off-screen
   * the map moves to it (flying, or at once under reduced motion) at least to the zoom where it is
   * drawn on its own (`zoom` asks for more), and at the maximum zoom its cluster is spiderfied
   * (zoomToShowLayer). False when the map has no such pin.
   */
  reveal(uid: string, options: { zoom?: number; animate: boolean; duration: number }, then: () => void): boolean {
    const m = this.markers.get(uid);
    if (!m || this.disposed) return false;
    // A newer reveal replaces a running one.
    this.cancelReveal();
    const token = this.revealToken;
    if (this.loads > 0) {
      this.idle.push(() => {
        if (token === this.revealToken) this.reveal(uid, options, then);
      });
      return true;
    }
    const map = this.map;
    const at = m.getLatLng();
    const zoom = map.getZoom();
    const target = Math.min(map.getMaxZoom(), Math.max(options.zoom ?? zoom, this.unclusterZoom(m)));
    if (map.hasLayer(m) && map.getBounds().contains(at) && target <= zoom) {
      then();
      return true;
    }
    const current = () => !this.disposed && token === this.revealToken;
    const group = this.group as unknown as GroupInternals;
    const finish = () => {
      if (!current()) return;
      // zoomToShowLayer would wait for a move that never comes while clusters still animate.
      if (group._inZoomAnimation) {
        this.group.once('animationend', finish);
        return;
      }
      this.pendingFinish = null;
      this.group.zoomToShowLayer(m, () => {
        if (current()) then();
      });
    };
    this.pendingFinish = finish;
    if (options.animate) {
      map.once('moveend', finish);
      map.flyTo(at, target, { duration: options.duration });
    } else {
      map.setView(at, target, { animate: false });
      finish();
    }
    return true;
  }

  /** Ends a running reveal (its flight may finish, but no zoom, spiderfy or popup follows). */
  private readonly cancelReveal = () => {
    this.revealToken += 1;
    const f = this.pendingFinish;
    if (!f) return;
    this.pendingFinish = null;
    this.map.off('moveend', f);
    this.group.off('animationend', f);
  };

  /** Opens a pin's popup when the pin is drawn on its own; false otherwise. */
  openPopup(uid: string): boolean {
    const m = this.markers.get(uid);
    if (!m || !this.map.hasLayer(m)) return false;
    m.openPopup();
    return true;
  }

  /** The popup of a pin while it is open. */
  openPopupOf(uid: string): L.Popup | null {
    const m = this.markers.get(uid);
    return m?.isPopupOpen() ? (m.getPopup() ?? null) : null;
  }

  stats(): PinStats {
    const view = this.map.getBounds();
    let drawn = 0;
    let inView = 0;
    let members = 0;
    for (const [uid, m] of this.markers) {
      if (this.map.hasLayer(m)) drawn += 1;
      if (view.contains(m.getLatLng())) inView += 1;
      if (this.members?.has(uid)) members += 1;
    }
    return { pins: this.markers.size, drawn, inView, members, loading: this.loads > 0 };
  }

  /**
   * Takes the layer off the map once no chunk is running, then runs `after` (the map's removal). No
   * sync, reveal or callback happens after this call.
   */
  dispose(after: () => void): void {
    this.disposed = true;
    this.queued = null;
    this.idle = [];
    this.cancelReveal();
    this.map.off('dragstart', this.cancelReveal);
    this.whenIdle(() => {
      const group = this.group as unknown as GroupInternals;
      // The end of a running cluster animation, now instead of on its timer.
      group._processQueue?.call(this.group);
      this.group.off();
      this.group.clearLayers();
      this.group.remove();
      after();
    });
  }

  private loaded(): void {
    this.loads = Math.max(0, this.loads - 1);
    if (this.loads > 0) return;
    if (this.disposed) {
      const waiting = this.idle;
      this.idle = [];
      waiting.forEach((f) => f());
      return;
    }
    if (this.queued) {
      const next = this.queued;
      this.queued = null;
      this.sync(next);
      if (this.loads > 0) return;
    }
    const waiting = this.idle;
    this.idle = [];
    waiting.forEach((f) => f());
    this.o.onChange();
  }

  private styleOf(r: PinRow): L.CircleMarkerOptions {
    return pinStyle(colourClassOf(r, this.colourBy).paint, emphasisOf(r.uid, this.members), r.uid === this.highlight);
  }

  private restyleAll(): void {
    for (const [uid, m] of this.markers) {
      const r = this.rows.get(uid);
      if (r) m.setStyle(this.styleOf(r));
    }
    this.group.refreshClusters();
    this.o.onChange();
  }

  private createMarker(p: PinRow): L.CircleMarker {
    const uid = p.uid;
    const m = L.circleMarker([p.pin.lat, p.pin.lng], { ...this.styleOf(p), renderer: this.renderer });
    m.bindPopup(() => this.o.popupContent(uid), this.o.popupOptions);
    m.on('popupopen', () => {
      if (!this.disposed) this.o.onPopupOpen(uid);
    });
    m.on('popupclose', () => {
      if (!this.disposed) this.o.onPopupClose(uid);
    });
    this.markers.set(uid, m);
    this.uids.set(m, uid);
    return m;
  }

  /** The zoom from which a pin is drawn on its own (one past its deepest cluster). */
  private unclusterZoom(m: L.CircleMarker): number {
    const parent = (m as unknown as MarkerInternals).__parent;
    const top = (this.group as unknown as GroupInternals)._topClusterLevel;
    if (!parent || parent === top || parent._zoom == null) return Math.floor(this.map.getMinZoom());
    return parent._zoom + 1;
  }

  private clusterIcon(cluster: L.MarkerCluster): L.DivIcon {
    const rows: PinRow[] = [];
    for (const m of cluster.getAllChildMarkers() as L.Layer[]) {
      const r = this.rows.get(this.uids.get(m) ?? '');
      if (r) rows.push(r);
    }
    const v = clusterView(rows, this.colourBy, this.members);
    const c = this.o.classes;
    // DOM with textContent only; the ring is the CSS gradient of the class mix.
    const ring = document.createElement('div');
    ring.className = c.ring;
    ring.style.background = v.ring;
    ring.setAttribute('role', 'img');
    ring.setAttribute('aria-label', v.text);
    ring.title = v.text;
    ring.dataset.count = String(v.total);
    if (this.members) ring.dataset.members = String(v.members);
    const label = document.createElement('span');
    label.className = c.label;
    label.textContent = v.label;
    ring.append(label);
    const state = v.dimmed ? c.dimmed : this.members ? c.member : '';
    return L.divIcon({ html: ring, className: `${c.icon} ${state}`.trim(), iconSize: [v.size, v.size] });
  }
}
