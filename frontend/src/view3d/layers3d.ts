/**
 * The deck.gl layers of the 3D view, built from a Scene (geometry.ts) and the panel's switches. Pure:
 * no React, no DOM; the screen hands the list to its Deck as it is.
 *
 * Every scene layer is drawn in metres from the scene's frame origin (METER_OFFSETS); only the map
 * tiles are placed in plain longitude and latitude. Layer ids are "<group>" or "<group>/<part>"; the
 * groups say what is shown (the stage's data-layers).
 *
 * Draw order: the map tiles first (they never write depth, so everything else shows in full colour over
 * them), then the opaque columns and groundwater markers, then the translucent layers from far to near
 * as seen from above (faint columns, the depth scale, the surfaces below ground, a thin veil at ground
 * level, then what lies on or above the ground), and the labels last, always on top. The veil is what
 * makes the ground read as glass: it dims what is below it a little and still hides behind what stands
 * above it.
 */
import { COORDINATE_SYSTEM, type Layer } from '@deck.gl/core';
import { BitmapLayer, ColumnLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers';
import { groundTiles, M_PER_DEG, tileUrl, type GroundTiles, type Rgba, type Scene, type SceneBorehole, type SceneSegment, type SceneWater, type ScaleRing, type Surface, type Vec3 } from './geometry';

/** How the groundwater readings of different boreholes are joined. */
export type WaterLink = 'off' | 'line' | 'surface';

/** What the panel switches on. */
export interface Show {
  boreholes: boolean;
  water: boolean;
  ground: boolean;
  rock: boolean;
  labels: boolean;
  basemap: boolean;
  scale: boolean;
  link: WaterLink;
}

export interface LayerInput {
  scene: Scene;
  show: Show;
  /** Tile URL template ({z}/{x}/{y}). */
  tileTemplate: string;
  /** A planned line's own path on the ground (scene metres, z = 0). */
  plannedLine: Vec3[][];
  /** The outline of an area drawn on the map (scene metres, z = 0). */
  areaOutline: Vec3[][];
  /** Text of a depth scale ring: "12 m", "231 m NN". */
  scaleLabel(ring: ScaleRing): string;
  /** Every how many rings a scale label goes (ringStride). */
  ringStride: number;
  /** Whether the borehole labels read at the current camera (labelsFit). */
  labelsFit: boolean;
  /** Radius the columns are drawn with at the current camera (m; radiusOnScreen). */
  radius: number;
}

/** Colours on the dark stage. */
export const COLOR = {
  water: [86, 170, 255, 255] as Rgba,
  waterGhost: [86, 170, 255, 110] as Rgba,
  waterSurface: [64, 156, 255, 90] as Rgba,
  waterLine: [130, 195, 255, 255] as Rgba,
  groundSurface: [150, 170, 110, 90] as Rgba,
  rockSurface: [170, 150, 190, 100] as Rgba,
  scale: [255, 255, 255, 70] as Rgba,
  scaleText: [235, 235, 235, 255] as Rgba,
  plannedLine: [255, 255, 255, 220] as Rgba,
  areaOutline: [255, 255, 255, 130] as Rgba,
  ghostRing: [255, 255, 255, 150] as Rgba,
  collar: [255, 255, 255, 230] as Rgba,
  drop: [255, 255, 255, 70] as Rgba,
  // Dark, so what lies below the ground is dimmed (not washed out) and what stands above it stays bright.
  veil: [22, 26, 32, 76] as Rgba,
  highlight: [255, 255, 255, 90] as Rgba,
  labelText: [17, 17, 17, 255] as Rgba,
  labelBackground: [255, 255, 255, 235] as Rgba,
};

/** Font of the text drawn in the scene (the app's sans-serif stack, without the licensed first choice). */
const FONT = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";

/** The group of a layer id: "basemap/17/68/44" → "basemap". */
export function layerGroup(id: string): string {
  const i = id.indexOf('/');
  return i < 0 ? id : id.slice(0, i);
}

/** The groups of a layer list, each once, in drawing order. */
export function layerGroups(layers: readonly Layer[]): string[] {
  return [...new Set(layers.map((l) => layerGroup(l.id)))];
}

/** Map tiles under a scene, worked out once per scene. */
const tileCache = new WeakMap<Scene, GroundTiles | null>();
function tilesOf(scene: Scene): GroundTiles | null {
  if (!tileCache.has(scene)) tileCache.set(scene, scene.bbox ? groundTiles(scene.bbox) : null);
  return tileCache.get(scene) ?? null;
}

/** A scene's segments, opaque and faint, split once per scene (the same arrays each time, so deck.gl keeps its buffers). */
const segmentCache = new WeakMap<Scene, { solid: SceneSegment[]; faint: SceneSegment[] }>();
function segmentsOf(scene: Scene): { solid: SceneSegment[]; faint: SceneSegment[] } {
  let split = segmentCache.get(scene);
  if (!split) {
    split = { solid: scene.segments.filter((s) => s.color[3] >= 255), faint: scene.segments.filter((s) => s.color[3] < 255) };
    segmentCache.set(scene, split);
  }
  return split;
}

/** The camera, as far as the text and the column width need it. */
export interface Camera {
  latitude: number;
  zoom: number;
  pitch: number;
}

/** Ground metres per screen pixel at the camera's centre (MapView: 512 px tiles). */
export function metresPerPixel(cam: Camera): number {
  return (M_PER_DEG * 360 * Math.max(Math.cos((cam.latitude * Math.PI) / 180), 1e-6)) / (512 * 2 ** cam.zoom);
}

/** Median distance between neighbouring boreholes (m), once per scene; 0 when they all stand together. */
const spacingCache = new WeakMap<Scene, number>();
export function boreholeSpacing(scene: Scene): number {
  const cached = spacingCache.get(scene);
  if (cached != null) return cached;
  const b = scene.boreholes;
  const nn: number[] = [];
  for (let i = 0; i < b.length; i++) {
    let d = Infinity;
    for (let j = 0; j < b.length; j++) if (j !== i) d = Math.min(d, Math.hypot(b[i].x - b[j].x, b[i].y - b[j].y));
    if (Number.isFinite(d) && d > 0.01) nn.push(d);
  }
  nn.sort((x, y) => x - y);
  const m = nn.length ? nn[nn.length >> 1] : 0;
  spacingCache.set(scene, m);
  return m;
}

/** Screen distance (px) below which the borehole labels would pile up: they show from here on. */
const LABEL_GAP_PX = 40;
/** Screen distance (px) two labelled scale rings keep at least. */
const RING_GAP_PX = 16;

/** True when the boreholes stand far enough apart on screen for their labels to read (always for one). */
export function labelsFit(scene: Scene, cam: Camera): boolean {
  if (scene.boreholes.length < 2) return true;
  const spacing = boreholeSpacing(scene);
  return spacing > 0 && spacing / metresPerPixel(cam) >= LABEL_GAP_PX;
}

/**
 * Every how many scale rings a label goes, so labels stay RING_GAP_PX apart on screen: 1 when the
 * rings stand apart, more when they crowd; Infinity (only the top ring) when they all coincide, as
 * seen straight from above.
 */
export function ringStride(scene: Scene, cam: Camera): number {
  const r = scene.scale.rings;
  if (r.length < 2) return 1;
  const px = (Math.abs(r[0].z - r[1].z) / metresPerPixel(cam)) * Math.sin((cam.pitch * Math.PI) / 180);
  return px >= RING_GAP_PX ? 1 : px > 0 ? Math.ceil(RING_GAP_PX / px) : Infinity;
}

/** The rings that get a label: the top one, then every stride-th. */
function labelledRings(rings: readonly ScaleRing[], stride: number): ScaleRing[] {
  return rings.filter((_, i) => i === 0 || (Number.isFinite(stride) && i % stride === 0));
}

/** A surface's triangles (fill) and edges (thin lines) under one group id. */
function surfaceLayers(group: string, surface: Surface, fill: Rgba, common: object): Layer[] {
  const edge: Rgba = [fill[0], fill[1], fill[2], Math.min(255, fill[3] * 2)];
  return [
    new SolidPolygonLayer<[Vec3, Vec3, Vec3]>({
      ...common,
      id: group,
      data: surface.triangles,
      getPolygon: (d) => d,
      getFillColor: fill,
      filled: true,
      extruded: false,
      _full3d: true,
      parameters: { depthWriteEnabled: false, cullMode: 'none' },
    }),
    new PathLayer<[Vec3, Vec3]>({
      ...common,
      id: `${group}/edges`,
      data: surface.edges,
      getPath: (d) => d,
      getColor: edge,
      getWidth: 1,
      widthUnits: 'pixels',
      parameters: { depthWriteEnabled: false },
    }),
  ];
}

/** Thin lines in scene metres. */
function lines(id: string, data: Vec3[][], color: Rgba, width: number, common: object): Layer {
  return new PathLayer<Vec3[]>({
    ...common,
    id,
    data,
    getPath: (d) => d,
    getColor: color,
    getWidth: width,
    widthUnits: 'pixels',
    billboard: true,
    jointRounded: true,
    capRounded: true,
    parameters: { depthWriteEnabled: false },
  });
}

/** The layers of a scene, in drawing order. Empty parts are left out. */
export function sceneLayers({ scene, show, tileTemplate, plannedLine, areaOutline, scaleLabel, ringStride: stride, labelsFit: fit, radius }: LayerInput): Layer[] {
  if (!scene.frame) return [];
  const common = {
    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
    coordinateOrigin: [scene.frame.lon0, scene.frame.lat0, 0] as [number, number, number],
  };
  const out: Layer[] = [];

  // The map, under everything: a grey ground that never writes depth.
  const tiles = show.basemap ? tilesOf(scene) : null;
  if (tiles) {
    for (const tile of tiles.tiles) {
      out.push(
        new BitmapLayer({
          id: `basemap/${tile.z}/${tile.x}/${tile.y}`,
          image: tileUrl(tileTemplate, tile),
          bounds: tile.bounds,
          desaturate: 1,
          opacity: 0.72,
          parameters: { depthWriteEnabled: false },
        }),
      );
    }
  }

  // Opaque: columns and groundwater markers.
  const { solid, faint } = segmentsOf(scene);
  const column = {
    ...common,
    getPosition: (d: SceneSegment) => d.position,
    getElevation: (d: SceneSegment) => d.height,
    getFillColor: (d: SceneSegment) => d.color,
    elevationScale: 1,
    extruded: true,
    radius,
    radiusUnits: 'meters' as const,
    diskResolution: 24,
    pickable: true,
    autoHighlight: true,
    highlightColor: COLOR.highlight,
  };
  if (show.boreholes && solid.length) out.push(new ColumnLayer<SceneSegment>({ ...column, id: 'columns', data: solid }));

  if (show.water && scene.water.length) {
    const marker = {
      ...common,
      getPosition: (d: SceneWater) => d.position,
      getRadius: 1.9 * radius,
      radiusUnits: 'meters' as const,
      billboard: false,
      lineWidthUnits: 'pixels' as const,
      pickable: true,
      autoHighlight: true,
      highlightColor: COLOR.highlight,
    };
    const filled = scene.water.filter((w) => w.filled);
    const open = scene.water.filter((w) => !w.filled);
    if (filled.length) {
      out.push(
        new ScatterplotLayer<SceneWater>({
          ...marker,
          id: 'water-markers',
          data: filled,
          filled: true,
          stroked: true,
          getFillColor: (d) => (d.ghost ? COLOR.waterGhost : COLOR.water),
          getLineColor: [255, 255, 255, 200],
          getLineWidth: 1,
        }),
      );
    }
    if (open.length) {
      out.push(
        new ScatterplotLayer<SceneWater>({
          ...marker,
          id: 'water-markers/open',
          data: open,
          filled: false,
          stroked: true,
          getLineColor: (d) => (d.ghost ? COLOR.waterGhost : COLOR.water),
          getLineWidth: 2.5,
        }),
      );
    }
  }

  if (show.link === 'line' && scene.waterLine.length) {
    out.push(lines('water-line', scene.waterLine, COLOR.waterLine, 3, common));
  }

  // Translucent, far to near as seen from above.
  if (show.boreholes && faint.length) {
    out.push(new ColumnLayer<SceneSegment>({ ...column, id: 'columns/faint', data: faint, parameters: { depthWriteEnabled: false } }));
  }
  if (show.scale && scene.scale.rings.length) {
    out.push(lines('scale', [...scene.scale.rings.map((r) => r.path), ...scene.scale.posts], COLOR.scale, 1, common));
  }
  if (show.rock && scene.rockSurface) out.push(...surfaceLayers('rock-surface', scene.rockSurface, COLOR.rockSurface, common));
  if (show.link === 'surface' && scene.waterSurface) out.push(...surfaceLayers('water-surface', scene.waterSurface, COLOR.waterSurface, common));

  // The veil at ground level, over the rectangle the tiles cover (plain longitude and latitude, like them).
  if (tiles && tiles.tiles.length) {
    const w = Math.min(...tiles.tiles.map((t) => t.bounds[0]));
    const s = Math.min(...tiles.tiles.map((t) => t.bounds[1]));
    const e = Math.max(...tiles.tiles.map((t) => t.bounds[2]));
    const n = Math.max(...tiles.tiles.map((t) => t.bounds[3]));
    out.push(
      new SolidPolygonLayer<[number, number][]>({
        id: 'basemap/veil',
        data: [[[w, s], [e, s], [e, n], [w, n]]],
        getPolygon: (d) => d,
        getFillColor: COLOR.veil,
        filled: true,
        extruded: false,
        parameters: { depthWriteEnabled: false },
      }),
    );
  }

  // On or above the ground.
  if (show.ground && scene.groundSurface) out.push(...surfaceLayers('ground-surface', scene.groundSurface, COLOR.groundSurface, common));
  // By elevation a collar stands above the map: a thin line down to it shows where the borehole is.
  if (show.boreholes && scene.mode === 'elevation') {
    const drops = scene.boreholes.filter((b) => b.placed && b.collarZ > 0).map((b): Vec3[] => [[b.x, b.y, 0], [b.x, b.y, b.collarZ]]);
    if (drops.length) out.push(lines('collars/drops', drops, COLOR.drop, 1, common));
  }
  // A dot at every collar, at least a few pixels wide: a site far away still shows where its boreholes are.
  if (show.boreholes && scene.boreholes.length) {
    out.push(
      new ScatterplotLayer<SceneBorehole>({
        ...common,
        id: 'collars',
        data: scene.boreholes,
        getPosition: (d) => [d.x, d.y, d.collarZ],
        getRadius: 0,
        radiusMinPixels: 2.5,
        billboard: true,
        filled: true,
        stroked: false,
        getFillColor: (d) => (d.placed ? COLOR.collar : COLOR.ghostRing),
        pickable: true,
        autoHighlight: true,
        highlightColor: COLOR.highlight,
        parameters: { depthWriteEnabled: false },
      }),
    );
  }
  if (show.boreholes && scene.ghostRings.length) out.push(lines('ghost-rings', scene.ghostRings, COLOR.ghostRing, 1.5, common));
  if (areaOutline.length) out.push(lines('area-outline', areaOutline, COLOR.areaOutline, 1.5, common));
  if (plannedLine.length) out.push(lines('planned-line', plannedLine, COLOR.plannedLine, 2, common));

  // Text, always on top.
  const text = {
    ...common,
    billboard: true,
    characterSet: 'auto' as const,
    fontFamily: FONT,
    sizeUnits: 'pixels' as const,
    parameters: { depthCompare: 'always' as const, depthWriteEnabled: false },
  };
  if (show.scale && scene.scale.rings.length) {
    out.push(
      new TextLayer<ScaleRing>({
        ...text,
        id: 'scale/labels',
        data: labelledRings(scene.scale.rings, stride),
        getPosition: (d) => d.path[1],
        getText: (d) => scaleLabel(d),
        getColor: COLOR.scaleText,
        getSize: 11,
        getTextAnchor: 'start',
        getAlignmentBaseline: 'center',
        getPixelOffset: [6, 0],
      }),
    );
  }
  if (show.labels && fit && scene.boreholes.length) {
    out.push(
      new TextLayer<SceneBorehole>({
        ...text,
        id: 'labels',
        data: scene.boreholes,
        getPosition: (d) => [d.x, d.y, d.collarZ],
        getText: (d) => d.id,
        getColor: COLOR.labelText,
        getSize: 11,
        fontWeight: 700,
        background: true,
        getBackgroundColor: COLOR.labelBackground,
        backgroundPadding: [4, 2],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'bottom',
        getPixelOffset: [0, -8],
        pickable: true,
      }),
    );
  }
  return out;
}
