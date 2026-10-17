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
 * A validator for a schema reference: a components.schemas name ("BoreholeRecord"), an array of one
 * ("array:BoreholeRecord"), or an operation's response ("response:approveClean:200").
 */
export function validatorFor(ref: string): ValidateFunction {
  const known = compiled.get(ref);
  if (known) return known;
  let fn: ValidateFunction | undefined;
  const [kind, a, b] = ref.split(':');
  if (kind === 'array' && hasSchema(a)) {
    fn = ajv.compile({ type: 'array', items: { $ref: `${DOC_ID}#/components/schemas/${a}` } });
  } else if (kind === 'response' && a && b) {
    fn = ajv.compile(rebase(responseSchema(a, b)) as object);
  } else if (hasSchema(ref)) {
    fn = ajv.getSchema(`${DOC_ID}#/components/schemas/${ref}`);
  }
  if (!fn) throw new Error(`Unknown schema reference "${ref}"`);
  compiled.set(ref, fn);
  return fn;
}

/** Validation errors of `data` against a schema reference (empty when valid). */
export function contractErrors(ref: string, data: unknown): string[] {
  const fn = validatorFor(ref);
  if (fn(data)) return [];
  return (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
}
