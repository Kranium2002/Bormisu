/**
 * The fictional wire fixtures (src/test/contract) and, once the backend writes them, the shared
 * examples in contracts/examples must validate against contracts/openapi.yaml. A rename in the
 * contract then fails here before it fails in the browser.
 */
import { describe, expect, it } from 'vitest';
import { contractErrors, hasSchema, openapi } from '../test/contract/schema';
import { FIXTURES } from '../test/contract/wire';

/** The backend's shared examples; an empty map while the folder doesn't exist. */
const examples = import.meta.glob<unknown>('../../../contracts/examples/*.json', { eager: true, import: 'default' });

/** File names of shared examples that name their payload differently from the schema. */
const ALIASES: Record<string, string> = {
  borehole: 'BoreholeRecord',
  borehole_record: 'BoreholeRecord',
  boreholes: 'BoreholeList',
  borehole_list: 'BoreholeList',
  document: 'Document',
  documents: 'DocumentList',
  document_list: 'DocumentList',
  errors: 'array:Error',
  crs_candidates: 'array:CrsCandidate',
  clarifications: 'array:Clarification',
  places: 'array:PlaceCandidate',
  geocode: 'array:PlaceCandidate',
};

const pascal = (s: string) => s.split(/[_\-\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');

/** The schema reference of a shared example file, or null when it can't be mapped. */
function exampleSchema(file: string, data: unknown): string | null {
  if (data && typeof data === 'object' && !Array.isArray(data) && typeof (data as { schema?: unknown }).schema === 'string' && 'example' in data) {
    return (data as unknown as { schema: string }).schema;
  }
  const base = (file.split('/').pop() ?? file).replace(/\.json$/, '').split('.')[0].toLowerCase();
  const alias = ALIASES[base];
  if (alias) return alias === 'BoreholeList' && Array.isArray(data) ? 'array:BoreholeRecord' : alias;
  if (hasSchema(pascal(base))) return pascal(base);
  const single = pascal(base.replace(/s$/, ''));
  if (Array.isArray(data) && hasSchema(single)) return `array:${single}`;
  return null;
}

describe('contract fixtures (src/test/contract)', () => {
  const names = Object.keys(FIXTURES);

  it('exist and are marked fictional', () => {
    expect(names.length).toBeGreaterThanOrEqual(15);
    for (const name of names) {
      expect(Object.keys(FIXTURES[name])[0], name).toBe('_fictional');
      expect(FIXTURES[name]._fictional, name).toMatch(/fictional/i);
    }
  });

  it.each(names)('%s validates against the contract', (name) => {
    const env = FIXTURES[name];
    expect(contractErrors(env.schema, env.example)).toEqual([]);
  });

  it('is checked against contract version 1.x', () => {
    expect(openapi.info.version).toMatch(/^1\./);
  });

  it('rejects payloads that break the contract (the validator really validates)', () => {
    const record = structuredClone(FIXTURES.borehole.example) as Record<string, unknown>;
    delete record.uid;
    expect(contractErrors('BoreholeRecord', record).join()).toMatch(/uid/);
    expect(contractErrors('Health', { status: 'ok', mode: 'sample' }).length).toBeGreaterThan(0);
    expect(contractErrors('ValuePatch', { path: 'metadata.borehole_id', action: 'undo' }).length).toBeGreaterThan(0);
    expect(contractErrors('response:approveClean:200', { count: -1 }).length).toBeGreaterThan(0);
  });
});

describe('shared examples (contracts/examples)', () => {
  const files = Object.keys(examples);

  it('validate against the contract when the backend has written them', () => {
    if (!files.length) {
      console.info('contracts/examples/ has no JSON files yet: nothing to validate.');
      return;
    }
    const failures: string[] = [];
    for (const file of files) {
      const data = examples[file];
      const ref = exampleSchema(file, data);
      if (!ref) {
        console.info(`contracts/examples: no schema known for ${file}; skipped.`);
        continue;
      }
      const payload = ref === (data as { schema?: string })?.schema ? (data as { example: unknown }).example : data;
      const errors = contractErrors(ref, payload);
      if (errors.length) failures.push(`${file} (${ref}): ${errors.slice(0, 5).join('; ')}`);
    }
    expect(failures).toEqual([]);
  });

  it('maps example file names to schemas', () => {
    expect(exampleSchema('x/health.json', {})).toBe('Health');
    expect(exampleSchema('x/borehole_record.json', {})).toBe('BoreholeRecord');
    expect(exampleSchema('x/boreholes.json', [])).toBe('array:BoreholeRecord');
    expect(exampleSchema('x/boreholes.json', { count: 0 })).toBe('BoreholeList');
    expect(exampleSchema('x/crs_candidates.json', [])).toBe('array:CrsCandidate');
    expect(exampleSchema('x/result_set.json', {})).toBe('ResultSet');
    expect(exampleSchema('x/whatever.json', {})).toBeNull();
    expect(exampleSchema('x/env.json', { schema: 'Health', example: {} })).toBe('Health');
  });
});
