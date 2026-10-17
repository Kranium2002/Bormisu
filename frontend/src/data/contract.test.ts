/**
 * The fictional wire fixtures (src/test/contract) and the backend's shared examples
 * (<repo>/contracts/examples) must validate against contracts/openapi.yaml and
 * contracts/realtime-and-chat.md. A rename in the contract then fails here before it fails in the browser.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_STREAMS,
  EXAMPLES,
  EXAMPLES_MISSING,
  EXAMPLES_PRESENT,
  eventFiles,
  eventTypeOf,
  schemaFiles,
  schemaNameOf,
} from '../test/contract/examples';
import examplesSource from '../test/contract/examples.ts?raw';
import { contractErrors, hasSchema, inlineErrors, openapi } from '../test/contract/schema';
import { FIXTURES } from '../test/contract/wire';
import wireSource from '../test/contract/wire.ts?raw';

/**
 * The `data` of each server-sent event (realtime-and-chat.md section 1): `document.updated` carries a
 * full Document, `clarification.created` a full Clarification, the others the small objects of the
 * table. Extra fields are allowed (additive changes inside 1.x); a renamed or missing field is not.
 */
const EVENT_SCHEMAS: Record<string, object> = {
  'document.updated': { $ref: '#/components/schemas/Document' },
  'document.deleted': {
    type: 'object', required: ['document_id'], properties: { document_id: { type: 'string', minLength: 1 } },
  },
  'borehole.created': {
    type: 'object',
    required: ['uid', 'document_id', 'revision', 'plotted'],
    properties: {
      uid: { type: 'string', minLength: 1 }, document_id: { type: 'string', minLength: 1 },
      revision: { type: 'integer', minimum: 1 }, plotted: { type: 'boolean' },
    },
  },
  'borehole.updated': {
    type: 'object',
    required: ['uid', 'revision'],
    properties: { uid: { type: 'string', minLength: 1 }, revision: { type: 'integer', minimum: 1 } },
  },
  'clarification.created': { $ref: '#/components/schemas/Clarification' },
  'clarification.resolved': {
    type: 'object',
    required: ['clarification_id', 'status'],
    properties: { clarification_id: { type: 'string', minLength: 1 }, status: { enum: ['answered', 'skipped'] } },
  },
  'job.failed': {
    type: 'object',
    required: ['document_id', 'stage', 'detail', 'retryable'],
    properties: {
      document_id: { type: 'string', minLength: 1 }, stage: { type: 'string' }, detail: { type: 'string' }, retryable: { type: 'boolean' },
    },
  },
};

/** Error codes the contract lists in the Error schema's description. */
function contractErrorCodes(): string[] {
  const description = (openapi.components.schemas.Error as { properties: { code: { description: string } } }).properties.code.description;
  const list = description.slice(description.indexOf(':') + 1);
  return list.split(',').map((c) => c.trim().replace(/\.$/, '')).filter(Boolean);
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
    expect(inlineErrors(EVENT_SCHEMAS['borehole.updated'], { uid: 'bh_x', rev: 2 }).length).toBeGreaterThan(0);
    expect(inlineErrors(EVENT_SCHEMAS['document.updated'], { document_id: 'doc_x' }).length).toBeGreaterThan(0);
  });
});

describe('example loading', () => {
  it('re-reads the examples folder on every run (no type argument on import.meta.glob, so Vitest never caches a stale file list)', () => {
    for (const [name, src] of Object.entries({ 'examples.ts': examplesSource, 'wire.ts': wireSource })) {
      expect(src, name).toContain('import.meta.glob(');
      expect(src, name).not.toMatch(/import\.meta\.glob</);
    }
  });
});

describe('example file names (contracts/examples/README.md naming rule)', () => {
  it('map <SchemaName>.<variant>.json and <SchemaName>.json to the schema, case-sensitive', () => {
    expect(schemaNameOf('BoreholeRecord.full.json')).toBe('BoreholeRecord');
    expect(schemaNameOf('BoreholeList.not_on_map.json')).toBe('BoreholeList');
    expect(schemaNameOf('CrsCandidate.list.json')).toBe('CrsCandidate');
    expect(schemaNameOf('Error.route_not_found.json')).toBe('Error');
    expect(schemaNameOf('Stats.json')).toBe('Stats');
    expect(schemaNameOf('events/document.updated.json')).toBeNull();
    expect(schemaNameOf('README.md')).toBeNull();
    // Case matters: "boreholerecord" is not a schema, so such a file fails instead of being skipped.
    expect(hasSchema(schemaNameOf('boreholerecord.full.json') as string)).toBe(false);
    expect(eventTypeOf('events/clarification.created.json')).toBe('clarification.created');
    expect(eventTypeOf('BoreholeRecord.full.json')).toBeNull();
  });
});

describe.skipIf(!EXAMPLES_PRESENT)(`shared examples (contracts/examples)${EXAMPLES_PRESENT ? '' : ` — skipped: ${EXAMPLES_MISSING}`}`, () => {
  const files = schemaFiles();

  it('has the examples the README promises', () => {
    expect(files.length).toBeGreaterThanOrEqual(60);
    const schemas = new Set(files.map(schemaNameOf));
    for (const s of ['Health', 'Document', 'DocumentList', 'BoreholeRecord', 'BoreholeList', 'ValuePatch', 'CrsCandidate', 'UploadAccepted', 'Error']) {
      expect(schemas.has(s), s).toBe(true);
    }
  });

  it.each(files)('%s validates against its schema (arrays per item)', (file) => {
    const schema = schemaNameOf(file);
    expect(schema && hasSchema(schema), `${file}: no schema "${schema}" in contracts/openapi.yaml`).toBe(true);
    const data = EXAMPLES[file];
    const items = Array.isArray(data) ? data : [data];
    if (Array.isArray(data)) expect(data.length, `${file} is an empty array`).toBeGreaterThan(0);
    const errors = items.flatMap((item, i) => contractErrors(schema as string, item).map((e) => (Array.isArray(data) ? `[${i}]${e}` : e)));
    expect(errors).toEqual([]);
  });

  it('has an Error example for every error code of the contract, and no other', () => {
    const codes = files.filter((f) => schemaNameOf(f) === 'Error').map((f) => f.split('.')[1]).sort();
    expect(codes).toEqual(contractErrorCodes().sort());
    for (const code of codes) expect((EXAMPLES[`Error.${code}.json`] as { code: string }).code).toBe(code);
  });

  const events = eventFiles();

  it('has an example for every event type of realtime-and-chat.md section 1', () => {
    expect(events.map(eventTypeOf).sort()).toEqual(Object.keys(EVENT_SCHEMAS).sort());
  });

  it.each(events)('%s validates against its event shape', (file) => {
    const type = eventTypeOf(file) as string;
    const schema = EVENT_SCHEMAS[type];
    expect(schema, `${file}: unknown event type`).toBeDefined();
    expect(inlineErrors(schema, EXAMPLES[file])).toEqual([]);
  });

  it.skip(`chat/*.sse streams (${Object.keys(CHAT_STREAMS).join(', ') || 'none'}) are checked with the chat drawer (M3)`, () => undefined);
});
