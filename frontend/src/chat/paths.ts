/**
 * The review value a contract path names (a provenance key such as `metadata.borehole_depth_m` or
 * `stratigraphy[2].depth_to_m`): chat citations and commands name values by path, the Review screen
 * and the Source panel by the value key of src/domain/keys.ts. Mirrors the rows adapters.ts builds;
 * a path without a dedicated row is its own key (adapters.ts keys such rows by their path).
 */
import { K } from '../domain/keys';
import type { Borehole } from '../domain/types';

const META: Record<string, string> = {
  'metadata.borehole_id': K.boreholeId,
  'metadata.borehole_name': K.boreholeName,
  'metadata.project_name': K.project,
  'metadata.project_id': K.projectId,
  'metadata.location_name': K.locationName,
  'metadata.country': K.country,
  'metadata.client': K.client,
  'metadata.drilling_contractor': K.contractor,
  'metadata.drilling_date': K.drillingDate,
  'metadata.start_date': K.startDate,
  'metadata.end_date': K.endDate,
  'metadata.drilling_method': K.method,
  'metadata.borehole_depth_m': K.finalDepth,
  'metadata.borehole_length_m': K.boreholeLength,
  'metadata.inclination_deg': K.inclination,
  'metadata.surface_elevation_mASL': K.elevation,
  'metadata.elevation_datum': K.elevationDatum,
  'metadata.depth_origin': K.depthOrigin,
  'metadata.coordinates.local_x': K.xy,
  'metadata.coordinates.local_y': K.xy,
  'metadata.coordinates.longitude': K.xy,
  'metadata.coordinates.latitude': K.xy,
  'metadata.coordinates.coordinate_system': K.crs,
  'metadata.coordinates.crs_code': K.crs,
  rock_head_m: K.rockHead,
  'metadata.casing_info': K.casing,
  'metadata.notes': K.notes,
};

const LAYER: Record<string, (n: number) => string> = {
  depth_to_m: K.bottom,
  english_lithology: K.lithology,
  original_description: K.lithology,
  stratigraphic_name: K.strat,
  engineering_soil_unit: K.soilUnit,
  geologic_age: K.age,
  colour: K.colour,
  consistency_density: K.consistency,
  moisture: K.moisture,
  weathering: K.weathering,
  is_core: K.core,
  spt_n_value: K.spt,
  spt_raw: K.spt,
  spt_refusal: K.spt,
  core_recovery_pct: K.tcr,
  rqd_pct: K.rqd,
  ucs_mpa: K.ucs,
};

/** Candidate keys of a path, best first. */
function candidates(path: string): string[] {
  const out: string[] = [];
  if (META[path]) out.push(META[path]);
  const layer = /^stratigraphy\[(\d+)\]\.(\w+)$/.exec(path);
  if (layer && LAYER[layer[2]]) out.push(LAYER[layer[2]](Number(layer[1]) + 1));
  const gw = /^groundwater\[(\d+)\]\.depth_m$/.exec(path);
  if (gw) out.push(K.gw(Number(gw[1])));
  const sample = /^samples\[(\d+)\]\.(name|depth_from_m)$/.exec(path);
  if (sample) out.push(sample[2] === 'name' ? K.sampleName(Number(sample[1])) : K.sampleDepth(Number(sample[1])));
  const test = /^test_results\[(\d+)\]\.value$/.exec(path);
  if (test) out.push(K.test(Number(test[1])));
  out.push(path);
  return out;
}

/** The key of the borehole's value that a path names, or null when the borehole has no such value. */
export function keyForPath(path: string | null | undefined, b: Borehole | undefined): string | null {
  if (!path || !b) return null;
  return candidates(path).find((k) => b.values.some((v) => v.key === k)) ?? null;
}
