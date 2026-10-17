/** All domain types of the Bormisu frontend (see ARCHITECTURE.md). */

export type Screen = 'map' | 'list' | 'queue' | 'review' | 'detail';
export type Method = 'Read' | 'OCR' | 'Derived' | 'Guessed' | 'Edited';
export type ReviewStatus = 'unreviewed' | 'approved' | 'flagged';
export type FieldState = 'ok' | 'not in source' | 'illegible';
export type BoreholeStatus = 'reviewed' | 'unreviewed' | 'attention';
export type CrsStatus = 'stated' | 'inferred' | 'confirmed' | 'unknown';
export type PageType = 'log' | 'lab_table' | 'text' | 'drawing' | 'photo' | 'unknown';
export type DocumentStep = 0 | 1 | 2 | 3; // classifying, extracting, needs review, done

/** Box on a page, normalised 0–1, origin top-left (same as the API contract). */
export interface Box { x: number; y: number; w: number; h: number }
export interface Lint { severity: 'error' | 'warning'; message: string }

export interface Spt {
  raw: string; depth: number; refusal: boolean;
  increments?: number[]; n?: number; blows?: number; penetrationCm?: number;
}

/** One extracted value with provenance and review state. The detail screen reads displayed values from here. */
export interface ExtractedValue {
  key: string;            // see keys.ts, unique within a borehole
  field: string;          // target-format field name (schema) or an extension name
  label: string;          // UI label, e.g. "Final depth", "SPT @ 10.50 m"
  group: 'borehole' | 'groundwater' | 'layer';
  layer?: number;
  raw: string;            // as printed in the source
  value: string;          // normalised, as text
  unit: string;
  page: number | null;
  box: Box | null;
  method: Method;
  confidence: number;     // 0–1, only shown on hover
  status: ReviewStatus;
  state: FieldState;
  aiValue: string;        // original AI value, kept after an edit
  note?: string; formula?: string; lint?: Lint; flag?: string;
  kind?: 'crs' | 'lithology' | 'spt';
  din?: string; refusal?: boolean; spt?: Spt;
}

export type PatternId = 'topsoil' | 'fill' | 'clay' | 'silt' | 'gravel' | 'sst' | 'sand' | 'lst' | 'marl';
/** DIN 4023 extras of a layer, as the source states them (absent = not stated, never a default). */
export interface LayerProps {
  /** Consistency or density as printed ("steif", "dense"); Table 6 symbol right of the column. */
  consistencyDensity?: string;
  /** Weathering grade w0 · w1 · w2_3 · w4 · w5 (Table 6). */
  weathering?: string;
  /** jointed · highly_jointed (Table 6). */
  jointing?: string;
  /** Wet although above the groundwater (Table 6). */
  wet?: boolean;
  /** A core was taken: double line left of the column (Table 5). */
  core?: boolean;
}
export interface Layer {
  n: number; from: number; to: number;
  lithology: string; lithologyAsPrinted: string; din: string;
  pattern: PatternId; fill: string; strat: string;   // stratigraphy code for the Strat. column (STRAT_COLORS)
  method: Method; confidence: number;
  spt?: Spt; tcr?: number; rqd?: number;
  props?: LayerProps;
  /** README_data `layers` columns not modelled above (uscs_group, stratigraphic_name, geologic_age). */
  fields?: Record<string, FieldValue>;
}
/** A value of a README_data.md column as the source states it; null = not stated. */
export type FieldValue = string | number | boolean | null;
/** One joint (crack) orientation measurement (README_data `joints`), printed like 135/25. */
export interface Joint { depth: number; dipDirection: number; dip: number }
/** One measured value of a lab test, e.g. water content 21.5 %. */
export interface TestValue { key: string; label: string; value: number; unit: string }
/** One sample / test depth with the values measured on it (only those the source states). */
export interface TestResult {
  sampleName: string | null;
  /** soil (box in DIN 4023) or water (open triangle); null = not stated. */
  sampleType: 'soil' | 'water' | null;
  depth: number | null;
  values: TestValue[];
}
/** strike = first water struck, rest = rest level; the API also reports standpipe and other readings. */
export type GroundwaterType = 'strike' | 'rest' | 'standpipe' | 'other';
export interface GroundwaterReading { type: GroundwaterType; depth: number; key: string }

export interface Borehole {
  uid: string;            // unique across documents, e.g. "nb:BK-07"
  id: string;             // BoreholeID as printed
  documentId: string | null;
  sourceFile: string;
  project: string;
  lat: number | null; lng: number | null;
  onMap: boolean; unplottedReason: string | null;
  /** Final depth in m, null when the source doesn't state it (logBottom then bounds the drawing). */
  finalDepth: number | null;
  logBottom: number;      // bottom of the last logged layer
  crs: { name: string | null; code: string | null; status: CrsStatus };
  layers: Layer[];
  groundwater: GroundwaterReading[];
  /** Lab tests, one per sample / test depth (API test_results[]); absent = none in the source. */
  testResults?: TestResult[];
  /** Joint orientations (README_data `joints`); absent = none in the source. */
  joints?: Joint[];
  /**
   * README_data `boreholes` columns not modelled above, keyed by their README name (location_name,
   * start_date, client, casing_info …). Absent or null = not stated.
   */
  fields?: Record<string, FieldValue>;
  rockHead: number | null;
  values: ExtractedValue[];
  primaryPage: number;
}

export interface PageItem { kind: 'text' | 'line'; x: number; y: number; w?: number; h?: number; text?: string; fontSize?: number; fontWeight?: number; color?: string }
/** A rendered page. API pages have imageUrl. Sample pages are drawn from items in a 560x780 px space. */
export interface PageContent { documentId: string; page: number; type: PageType; usage: string; label: string; imageUrl?: string; items?: PageItem[] }

export interface LintFinding { severity: 'error' | 'warning'; boreholeId: string; message: string }
export interface Completeness {
  listed: number; idPrefix: string; missing: string[]; unexpected: string[]; lint: LintFinding[];
  /** IDs named in the report, when known (API). Otherwise they are `idPrefix` + 01…listed. */
  expectedIds?: string[];
}
export interface DocumentSummary {
  id: string; name: string; project: string;
  pageTypes: PageType[];            // one per page; 'unknown' = not classified yet
  step: DocumentStep;
  counts: { boreholes: number; layers: number; spt: number; groundwater: number } | null;
  completeness: Completeness | null;
  reviewBoreholeUid: string | null; // the borehole the Review screen opens for this document
  uploaded?: boolean;
  simulated?: boolean;              // sample mode upload, which shows "Simulated: live extraction needs an API key"
  error?: string | null;            // extraction failed (API status "failed")
}
export interface CrsCandidate { name: string; code: string; note: string; verdict: 'match' | 'shifted' | 'out_of_range'; points: { uid: string; lat: number; lng: number }[] }
export type ValuePatch = Partial<Pick<ExtractedValue, 'value' | 'status' | 'state' | 'flag' | 'method'>>;

/** Page sizes of the sample page drawing space (px). Boxes are normalised against these. */
export const PAGE_W = 560;
export const PAGE_H = 780;
