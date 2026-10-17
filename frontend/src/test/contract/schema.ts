/**
 * Contract validation for tests: compiles contracts/openapi.yaml with Ajv (JSON Schema 2020-12, which
 * OpenAPI 3.1 schemas are) so fixtures and request bodies are checked against the real contract.
 * Not used by the app.
 */
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import { parse } from 'yaml';
import openapiText from '../../../../contracts/openapi.yaml?raw';

/** Id under which the whole OpenAPI document is registered; schema refs resolve against it. */
const DOC_ID = 'openapi.json';

interface Operation {
  operationId?: string;
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}
interface OpenApi {
  info: { version: string };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown> };
}

/** The parsed contract. */
export const openapi = parse(openapiText) as OpenApi;

const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema(openapi as object, DOC_ID);

const compiled = new Map<string, ValidateFunction>();

/** Points local refs ("#/components/...") of an inline schema at the registered document. */
function rebase(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rebase);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node).map(([k, v]) => [k, k === '$ref' && typeof v === 'string' && v.startsWith('#') ? DOC_ID + v : rebase(v)]),
  );
}

/** The inline JSON schema of an operation's response, e.g. ("approveClean", "200"). */
function responseSchema(operationId: string, status: string): unknown {
  for (const item of Object.values(openapi.paths)) {
    for (const op of Object.values(item)) {
      if (op && typeof op === 'object' && op.operationId === operationId) {
        const content = op.responses?.[status]?.content ?? {};
        const schema = Object.values(content)[0]?.schema;
        if (schema) return schema;
      }
    }
  }
  throw new Error(`No response schema for ${operationId} ${status} in the contract`);
}

/** True when the contract defines components.schemas[name]. */
export function hasSchema(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(openapi.components.schemas, name);
}

/**
 * The `data` of each server-sent event (contracts/realtime-and-chat.md section 1): `document.updated`
 * carries a full Document, `clarification.created` a full Clarification, the others the small objects
 * of the table. Extra fields are allowed (additive changes inside 1.x); a renamed or missing field is not.
 */
export const EVENT_SCHEMAS: Readonly<Record<string, object>> = {
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

/**
 * A validator for a schema reference: a components.schemas name ("BoreholeRecord"), an array of one
 * ("array:BoreholeRecord"), an operation's response ("response:approveClean:200"), or the data of a
 * server-sent event ("event:borehole.created", see EVENT_SCHEMAS).
 */
export function validatorFor(ref: string): ValidateFunction {
  const known = compiled.get(ref);
  if (known) return known;
  let fn: ValidateFunction | undefined;
  const [kind, a, b] = ref.split(':');
  const eventType = ref.slice('event:'.length);
  if (kind === 'array' && hasSchema(a)) {
    fn = ajv.compile({ type: 'array', items: { $ref: `${DOC_ID}#/components/schemas/${a}` } });
  } else if (kind === 'event' && Object.prototype.hasOwnProperty.call(EVENT_SCHEMAS, eventType)) {
    fn = ajv.compile(rebase(EVENT_SCHEMAS[eventType]) as object);
  } else if (kind === 'response' && a && b) {
    fn = ajv.compile(rebase(responseSchema(a, b)) as object);
  } else if (hasSchema(ref)) {
    fn = ajv.getSchema(`${DOC_ID}#/components/schemas/${ref}`);
  }
  if (!fn) throw new Error(`Unknown schema reference "${ref}"`);
  compiled.set(ref, fn);
  return fn;
}

const messages = (fn: ValidateFunction) => (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);

/** Validation errors of `data` against a schema reference (empty when valid). */
export function contractErrors(ref: string, data: unknown): string[] {
  const fn = validatorFor(ref);
  return fn(data) ? [] : messages(fn);
}

const inline = new WeakMap<object, ValidateFunction>();

/**
 * Validation errors of `data` against an inline JSON schema, for shapes the contract defines outside
 * the OpenAPI file (the small event payloads of contracts/realtime-and-chat.md). Local refs
 * ("#/components/schemas/...") point into the contract.
 */
export function inlineErrors(schema: object, data: unknown): string[] {
  let fn = inline.get(schema);
  if (!fn) {
    fn = ajv.compile(rebase(schema) as object);
    inline.set(schema, fn);
  }
  return fn(data) ? [] : messages(fn);
}
