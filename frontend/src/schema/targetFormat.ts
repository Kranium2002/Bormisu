/**
 * Herrenknecht standard format (BoreholeDataFormat.xlsx): the single definition of the
 * target sections and fields. Export and labels read from here; don't repeat field names elsewhere.
 */
import type { Layer } from '../domain/types';

export type FieldFormat = 'alphanumeric' | 'numeric' | 'Date' | 'boolean' | 'color/pattern';

export interface FieldDef {
  name: string;
  format: FieldFormat;
  unit: string;
  note?: string;
  /** Log-data fields that are filled from a layer property rather than from an extracted value. */
  layerProp?: keyof Pick<Layer, 'strat' | 'din'>;
}

export type SectionId = 'metadata' | 'logdata' | 'testResults';

export interface SectionDef {
  id: SectionId;
  /** Sheet title in the template and in the export. */
  title: string;
  optional: boolean;
  fields: readonly FieldDef[];
}

/** The standard the template refers to for the profile drawing. */
export const REGULATION = 'DIN 4023';

const METADATA = [
  { name: 'BoreholeID', format: 'alphanumeric', unit: '-' },
  { name: 'BoreholeName', format: 'alphanumeric', unit: '-' },
  { name: 'LocationName', format: 'alphanumeric', unit: '-' },
  { name: 'StartDate', format: 'Date', unit: '-' },
  { name: 'EndDate', format: 'Date', unit: '-' },
  { name: 'ProjectID', format: 'alphanumeric', unit: '-' },
  { name: 'ProjectName', format: 'alphanumeric', unit: '-' },
  { name: 'Surface Elevation', format: 'numeric', unit: 'mASL', note: 'Level of ground above mean sealevel' },
  { name: 'X-Coordinate', format: 'numeric', unit: 'm/°', note: 'Geographic or UTM' },
  { name: 'Y-Coordinate', format: 'numeric', unit: 'm/°', note: 'Geographic or UTM' },
  { name: 'CoordinateSystem', format: 'alphanumeric', unit: '-', note: 'Geogr./UTM/G-K…' },
  { name: 'BoreholeDepth', format: 'numeric', unit: 'm', note: 'if ft, transfer to m' },
  { name: 'BoreholeLength', format: 'numeric', unit: 'm', note: 'if ft, transfer to m' },
  { name: 'Notes', format: 'alphanumeric', unit: '-' },
] as const satisfies readonly FieldDef[];

const LOGDATA = [
  { name: 'StratigraphicName', format: 'alphanumeric', unit: '-', layerProp: 'strat' },
  { name: 'EngineeringSoilUnit', format: 'alphanumeric', unit: '-' },
  { name: 'GeologicAge', format: 'alphanumeric', unit: '-' },
  { name: 'Lithology/SoilName', format: 'alphanumeric', unit: '-' },
  { name: 'Soil/Rockprofile', format: 'color/pattern', unit: '-', layerProp: 'din' },
  { name: 'Core', format: 'boolean', unit: 'yes/no' },
  { name: 'SampleName', format: 'alphanumeric', unit: '-' },
  { name: 'SampleDepth', format: 'numeric', unit: 'm' },
  { name: 'TotalCoreRecovery', format: 'numeric', unit: '%' },
  { name: 'RQD', format: 'numeric', unit: '%' },
  { name: 'SPT', format: 'numeric', unit: 'n' },
  { name: 'Groundwaterlevel', format: 'numeric', unit: 'm' },
] as const satisfies readonly FieldDef[];

const TEST_RESULTS = [
  { name: 'Watercontent', format: 'numeric', unit: '%' },
  { name: 'Cosistency', format: 'numeric', unit: '%', note: 'sic, Consistency' },
  { name: 'Unitweight', format: 'numeric', unit: 'kN/m³' },
  { name: 'UCS', format: 'numeric', unit: 'MPa' },
  { name: 'Tensile strength', format: 'numeric', unit: 'MPa' },
  { name: 'CAI', format: 'numeric', unit: '-', note: 'Cerchar Index' },
  { name: 'RMR', format: 'numeric', unit: '-' },
  { name: 'Q', format: 'numeric', unit: '-' },
  { name: 'GSI', format: 'numeric', unit: '-' },
  { name: 'FrictionAngle', format: 'numeric', unit: '°' },
  { name: 'Cohesion', format: 'numeric', unit: 'kPa' },
  { name: 'Grainsize-fines', format: 'numeric', unit: '%' },
  { name: 'LiquidLimit', format: 'numeric', unit: '%' },
  { name: 'PlasticityLimit', format: 'numeric', unit: '%' },
  { name: 'PlasticityIndex', format: 'numeric', unit: '-' },
  { name: 'ConsistencyIndex', format: 'numeric', unit: '-' },
  { name: 'HydraulicCoefficient', format: 'numeric', unit: 'm/s' },
  { name: 'E-Modulus', format: 'numeric', unit: 'MPa' },
  { name: 'PoissonsRatio', format: 'numeric', unit: '-' },
] as const satisfies readonly FieldDef[];

/** All sections, in template order. */
export const SECTIONS: readonly SectionDef[] = [
  { id: 'metadata', title: 'Metadata', optional: false, fields: METADATA },
  { id: 'logdata', title: 'Logdata', optional: false, fields: LOGDATA },
  { id: 'testResults', title: 'Test Results', optional: true, fields: TEST_RESULTS },
];

/** Any field name of the standard format; use it to type ExtractedValue.field at creation sites. */
export type TargetFieldName =
  | (typeof METADATA)[number]['name']
  | (typeof LOGDATA)[number]['name']
  | (typeof TEST_RESULTS)[number]['name'];

/** Returns a section by id. */
export function section(id: SectionId): SectionDef {
  const s = SECTIONS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown target-format section: ${id}`);
  return s;
}

/**
 * Separator for a value that holds two target fields at once (e.g. "X / Y"): the field name is
 * "X-Coordinate / Y-Coordinate" and the value "3513420 / 5405870". The export splits both.
 */
export const MULTI_FIELD_SEPARATOR = ' / ';

/** Field name of a value that holds two target fields. */
export function multiField<A extends TargetFieldName, B extends TargetFieldName>(a: A, b: B): `${A} / ${B}` {
  return `${a} / ${b}`;
}

/** Fields the app extracts or exports beyond the template. */
export const EXTRA_FIELDS = {
  depthFrom: 'DepthFrom',
  depthTo: 'DepthTo',
  drillingMethod: 'DrillingMethod',
  rockHead: 'RockHead',
} as const;

/** Any name allowed in ExtractedValue.field. */
export type ValueFieldName =
  | TargetFieldName
  | (typeof EXTRA_FIELDS)[keyof typeof EXTRA_FIELDS]
  | ReturnType<typeof multiField<'X-Coordinate', 'Y-Coordinate'>>;
