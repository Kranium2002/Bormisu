/**
 * The backend's shared contract examples in <repo>/contracts/examples (all fictional; see the README
 * there). They reach this branch when feat/backend merges into integration; until then the folder is
 * absent, `EXAMPLES_PRESENT` is false and the suites that read the examples skip. Not used by the app.
 *
 * Naming rule (contracts/examples/README.md): `<SchemaName>.<variant>.json` or `<SchemaName>.json`
 * validates against `#/components/schemas/<SchemaName>`; a top-level array validates per item.
 * `events/<event-type>.json` is the data of one server-sent event, `chat/*.sse` one chat response body.
 */

/** Paths are resolved from this file: src/test/contract → <repo>/contracts/examples. */
const ROOT = '../../../../contracts/examples/';

// Written as `import.meta.glob(` without a type argument on purpose: Vitest's file-system module cache
// skips only modules whose text contains exactly "import.meta.glob(". With `glob<T>(` this module was
// cached with the files of an earlier run, so examples that arrive later (the backend merge) stayed
// invisible until `vitest --clearCache`.
const jsonFiles = import.meta.glob('../../../../contracts/examples/**/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const sseFiles = import.meta.glob('../../../../contracts/examples/chat/*.sse', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const readme = import.meta.glob('../../../../contracts/examples/README.md', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

/** True when <repo>/contracts/examples exists on this branch. */
export const EXAMPLES_PRESENT = Object.keys(readme).length > 0 || Object.keys(jsonFiles).length > 0;

/** Why the example suites skip. */
export const EXAMPLES_MISSING =
  'contracts/examples is not on this branch yet: it arrives when feat/backend merges into integration ' +
  '(to run these suites now: git checkout feat/backend -- contracts/examples, and remove it before committing)';

const rel = (path: string) => path.slice(ROOT.length);

/** Every JSON example by its path inside contracts/examples, e.g. "BoreholeRecord.full.json", "events/document.updated.json". */
export const EXAMPLES: Readonly<Record<string, unknown>> = Object.fromEntries(
  Object.entries(jsonFiles).map(([path, data]) => [rel(path), data]),
);

/** Every chat stream example by its path, e.g. "chat/turn.sse". */
export const CHAT_STREAMS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(sseFiles).map(([path, text]) => [rel(path), text]),
);

/** Top-level example files (schema examples), sorted. */
export function schemaFiles(): string[] {
  return Object.keys(EXAMPLES).filter((f) => !f.includes('/')).sort();
}

/** Event example files (`events/<type>.json`), sorted. */
export function eventFiles(): string[] {
  return Object.keys(EXAMPLES).filter((f) => f.startsWith('events/')).sort();
}

/**
 * The schema name of a top-level example file by the README's rule: the part before the first dot
 * (case-sensitive), e.g. "BoreholeRecord.full.json" → "BoreholeRecord", "Stats.json" → "Stats".
 * Null for a name the rule doesn't cover (a nested path or no ".json").
 */
export function schemaNameOf(file: string): string | null {
  if (file.includes('/') || !file.endsWith('.json')) return null;
  const name = file.slice(0, -'.json'.length).split('.')[0];
  return name || null;
}

/** The event type of an `events/<type>.json` file, e.g. "document.updated". */
export function eventTypeOf(file: string): string | null {
  const m = /^events\/(.+)\.json$/.exec(file);
  return m ? m[1] : null;
}

/** A deep copy of one example (path inside contracts/examples), typed by the caller. */
export function example<T>(file: string): T {
  if (!(file in EXAMPLES)) throw new Error(`No contract example "${file}" in contracts/examples`);
  return structuredClone(EXAMPLES[file]) as T;
}

/** Deep copies of every top-level example of one schema, as [file, payload] pairs, sorted by file. */
export function examplesOf<T>(schema: string): [string, T][] {
  return schemaFiles()
    .filter((f) => schemaNameOf(f) === schema)
    .map((f) => [f, example<T>(f)]);
}
