/**
 * All domain types of the frontend (see ARCHITECTURE.md). Wire shapes live in
 * src/data/api-types.gen.ts and only src/data/ knows them. Unknown is `null` (or '' for display
 * text): never a default value that the source doesn't state.
 */

export type Screen = 'map' | 'queue' | 'review' | 'detail';
/** How a value was obtained (contract `Method`: read | ocr | derived | guessed | edited). */
export type Method = 'Read' | 'OCR' | 'Derived' | 'Guessed' | 'Edited';
/** Review status of one value. */
export type ReviewStatus = 'unreviewed' | 'approved' | 'flagged';
export type FieldState = 'ok' | 'not in source' | 'illegible';
/** Review status of a borehole, computed by the backend (contract `BoreholeRecord.review_status`). */
export type BoreholeReviewStatus = 'unreviewed' | 'in_review' | 'approved';
/**
 * What chips and pins show: `attention` (a flagged value, a lint error or an open clarification)
 * wins over the review status.
 */
export type BoreholeStatus = BoreholeReviewStatus | 'attention';
export type CrsStatus = 'stated' | 'inferred' | 'confirmed' | 'unknown';
/** Why a borehole is not on the map (contract codes; the UI maps them to labels). */
export type UnplottedReason = 'no_coordinates' | 'crs_unknown' | 'crs_unconfirmed' | 'implausible';
export type PageType = 'log' | 'lab_table' | 'text' | 'drawing' | 'photo' | 'unknown';
/** Fine page label from the backend's classifier (contract `PageRole`). */
export type PageRole =
  | 'log_sheet' | 'log_continuation' | 'summary_table' | 'coordinate_table' | 'lab_results' | 'legend_or_key'
  | 'location_plan' | 'cross_section' | 'narrative' | 'cover_or_toc' | 'photos' | 'blank' | 'duplicate' | 'other';
export type DocumentStatus = 'queued' | 'classifying' | 'extracting' | 'needs_review' | 'done' | 'failed';
export type DocumentStep = 0 | 1 | 2 | 3; // classifying, extracting, needs review, done
export type CrsVerdict = 'match' | 'shifted' | 'out_of_range';
export type DepthOrigin = 'ground' | 'mudline' | 'seabed' | 'relative';
export type DepthSource = 'printed' | 'end_note' | 'last_layer';

/** Box on a page, normalised 0–1, origin top-left (same as the API contract). */
export interface Box { x: number; y: number; w: number; h: number }
export interface Lint {
  severity: 'error' | 'warning'; message: string;
  /** A check the client adds on its own (e.g. SPT increments); it is shown but never counts as attention. */
  client?: boolean;
}

/** Server state shown at boot (contract `Health`); `sample` is the in-browser fictional data source. */
export interface Health {
  /** live: extraction works; demo: the backend has no provider keys; sample: fictional demo data. */
  mode: 'live' | 'demo' | 'sample';
  status: 'ok' | 'degraded';
  version: string;
  providers: { ocr: boolean; classifier: boolean; extractor: boolean; chat: boolean; geocoder: boolean };
  /** Server upload limits; the drop zone mirrors them. Extensions are lower case with a dot (".pdf"). */
  upload: { maxMb: number; extensions: string[] };
}

export interface Spt {
  raw: string;
  /** Test depth in m; null when the source doesn't state it (shown as "depth not stated", never invented). */
  depth: number | null;
  refusal: boolean;
  increments?: number[]; n?: number; blows?: number; penetrationCm?: number;
  /** Length of one increment in mm (e.g. 150 or 75), when stated. */
  incrementMm?: number;
}

/** One independent reading of a value when two readers disagreed (handwriting). */
export interface Reading { reader: string; text: string; confidence: number | null }

/** One extracted value with provenance and review state. The detail screen reads displayed values from here. */
export interface ExtractedValue {
  key: string;            // see keys.ts, unique within a borehole
  field: string;          // target-format field name (schema) or an extension name
  label: string;          // UI label, e.g. "Final depth", "SPT @ 10.50 m"
  group: 'borehole' | 'groundwater' | 'layer' | 'sample' | 'test';
  layer?: number;
  /** Index in the borehole's samples / testResults list, for the sample and test groups. */
  index?: number;
  raw: string;            // as printed in the source
  value: string;          // normalised, as text ('' = none)
  unit: string;
  page: number | null;
  box: Box | null;
  /** Spreadsheet source cell, e.g. "Logdata!C5"; page and box are null then. */
  cell?: string;
  /** Source document of this value when it isn't the borehole's own document (e.g. a lab spreadsheet). */
  documentId?: string;
  /** Why the value can't be edited here even though it has provenance (e.g. a CRS set only through the CRS dialog). */
  readOnlyReason?: string;
  /**
   * False when the backend sent no provenance entry for the value (the contract allows sparse
   * provenance; the API source logs one summary per load): the value shows no source icon and can't
   * be reviewed, because only provenance keys are valid PATCH paths.
   */
  hasProvenance: boolean;
  /** null when unknown (no provenance). */
  method: Method | null;
  /** 0–1, only shown on hover; null when the source gives none. */
  confidence: number | null;
  status: ReviewStatus;
  state: FieldState;
  aiValue: string;        // original AI value, kept after an edit
  /** Independent readings, shown side by side when readers disagreed. */
  readings?: Reading[];
  note?: string; formula?: string; lint?: Lint; flag?: string;
  kind?: 'crs' | 'lithology' | 'spt';
  din?: string; refusal?: boolean; spt?: Spt;
}

export interface Layer {
  n: number; from: number; to: number;
  /** English lithology, '' when the source gives none. */
  lithology: string;
  /** Description as printed, '' when none. */
  lithologyAsPrinted: string;
  /** Main component as a key of din_codes.json (case-sensitive: `mG` is not `Mg`), or null. Never guessed. */
  din: string | null;
  /** Full DIN short form, e.g. "U, t, s'". */
  dinNotation: string | null;
  stratigraphicName: string | null;
  engineeringSoilUnit: string | null;
  geologicAge: string | null;
  colour: string | null;
  consistency: string | null;
  moisture: string | null;
  weathering: string | null;
  isCore: boolean | null;
  /** Method and confidence of the layer's lithology value. */
  method: Method | null; confidence: number | null;
  spt?: Spt; tcr?: number; rqd?: number;
}
/** strike = first water struck, rest = rest level; the API also reports standpipe and other readings. */
export type GroundwaterType = 'strike' | 'rest' | 'standpipe' | 'other';
export interface GroundwaterReading {
  type: GroundwaterType;
  /** Depth in m below the depth origin; null when only an elevation or a remark ("dry") is given. */
  depth: number | null;
  elevation: number | null;
  date: string | null;
  raw: string | null;
  /** Key of the reading's depth value. */
  key: string;
}
export interface Sample { name: string; typeCode: string | null; from: number | null; to: number | null; key: string }
/** One lab or in-situ result, named after a Test Results field of the target format (e.g. "UCS"). */
export interface TestResult {
  name: string; value: number | null; qualifier: string | null; unit: string | null;
  sampleName: string | null; depth: number | null; key: string;
}

/** Borehole metadata beyond the reviewed values: shown in Detail; exports read the values. */
export interface BoreholeMeta {
  aliases: string[];
  elevationDatum: string | null;
  depthOrigin: DepthOrigin | null;
  depthSource: DepthSource | null;
  /** Coordinates exactly as printed, shown next to the converted values. */
  xRaw: string | null; yRaw: string | null; axisLabelsRaw: string | null;
  localX: number | null; localY: number | null;
}

export interface Borehole {
  /** Opaque, unique id (server `bh_<ULID>`). Never parsed. */
  uid: string;
  id: string;             // BoreholeID as printed (not unique)
  documentId: string | null;
  sourceFile: string;
  project: string;
  /** Server revision; review saves send it as `if_revision`. */
  revision: number;
  /** Computed by the backend; the client only derives it for the moment between a click and the answer. */
  reviewStatus: BoreholeReviewStatus;
  openClarifications: number;
  lat: number | null; lng: number | null;
  onMap: boolean; unplottedReason: UnplottedReason | null;
  /** Final depth in m, null when the source doesn't state it (logBottom then bounds the drawing). */
  finalDepth: number | null;
  logBottom: number;      // bottom of the last logged layer (drawing only)
  crs: { name: string | null; code: string | null; status: CrsStatus };
  meta: BoreholeMeta;
  layers: Layer[];
  groundwater: GroundwaterReading[];
  samples: Sample[];
  testResults: TestResult[];
  rockHead: number | null;
  values: ExtractedValue[];
  /** Pages this borehole was read from (1-based). */
  pages: number[];
  /** First source page; null when the borehole has no page (e.g. read from a spreadsheet only). */
  primaryPage: number | null;
}

export interface PageItem { kind: 'text' | 'line'; x: number; y: number; w?: number; h?: number; text?: string; fontSize?: number; fontWeight?: number; color?: string }
/** A rendered page. API pages have imageUrl. Sample pages are drawn from items in a 560x780 px space. */
export interface PageContent { documentId: string; page: number; type: PageType; usage: string; label: string; imageUrl?: string; items?: PageItem[] }

/** One page of a document as classified by the backend; unclassified pages are placeholders. */
export interface DocumentPage {
  n: number;
  /** 'unknown' until classified. */
  type: PageType;
  role: PageRole | null;
  /** True when the page fed extraction. */
  used: boolean;
  unusedReason: string | null;
  /** Borehole labels as printed on the page. */
  boreholeIds: string[];
  sheetLabel: string | null;
  handwriting: 'none' | 'annotations' | 'partial' | 'full' | null;
  language: string | null;
  ocr: 'pending' | 'done' | 'skipped' | 'failed' | null;
  duplicateOf: { documentId: string; n: number } | null;
  /** False for a placeholder of a page the backend hasn't classified yet. */
  classified: boolean;
}
export interface DocumentProgress {
  pagesTotal: number; pagesClassified: number; pagesOcrTotal: number; pagesOcrDone: number; boreholesExtracted: number;
}

export interface LintFinding { severity: 'error' | 'warning'; boreholeId: string; message: string }
export interface Completeness {
  listed: number; idPrefix: string; missing: string[]; unexpected: string[]; lint: LintFinding[];
  /** IDs named in the report, when known (API). Otherwise they are `idPrefix` + 01…listed. */
  expectedIds?: string[];
}
export interface DocumentSummary {
  id: string; name: string; project: string;
  status: DocumentStatus;
  /** One entry per page, 1..page count; unclassified pages are placeholders (`classified: false`). */
  pages: DocumentPage[];
  step: DocumentStep;
  progress: DocumentProgress | null;
  counts: { boreholes: number; layers: number; spt: number; groundwater: number } | null;
  completeness: Completeness | null;
  reviewBoreholeUid: string | null; // the borehole the Review screen opens for this document
  openClarifications: number;
  /** Document id of an earlier upload with the same bytes. */
  duplicateOf: string | null;
  uploaded?: boolean;
  /** The last upload carried bytes this document already has (the backend answered with it, nothing is reprocessed). */
  uploadedAgain?: boolean;
  simulated?: boolean;              // sample mode upload, which shows "Simulated: live extraction needs an API key"
  error?: string | null;            // extraction failed (API status "failed")
}
export interface CrsCandidate {
  name: string; code: string; note: string | null; score: number | null; verdict: CrsVerdict | null;
  /** True when the printed X is the northing. Sent back with the confirmation. */
  swapAxes: boolean;
  points: { uid: string; lat: number; lng: number }[];
}
/** A CRS confirmation for every borehole of a document. */
export interface CrsConfirmation { code: string; swapAxes: boolean; confirmedBy: string | null }
/**
 * A review action on one value. `status: 'unreviewed'` undoes an approval or a flag (API action
 * `reset`); `state: 'ok'` sets the state back (API `set_state`).
 */
export type ValuePatch = Partial<Pick<ExtractedValue, 'value' | 'status' | 'state' | 'flag' | 'method'>>;

/** Labels of the unplotted reason codes. */
export const UNPLOTTED_LABELS: Record<UnplottedReason, string> = {
  no_coordinates: 'No coordinates in source',
  crs_unknown: 'Coordinate system unknown',
  crs_unconfirmed: 'Coordinate system needs confirmation',
  implausible: 'Coordinates implausible',
};

/** Page sizes of the sample page drawing space (px). Boxes are normalised against these. */
export const PAGE_W = 560;
export const PAGE_H = 780;
