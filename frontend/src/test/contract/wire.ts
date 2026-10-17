/**
 * Loads the fictional wire fixtures of this folder. Each file is an envelope
 * `{_fictional, schema, example}`: `schema` names what `example` must validate against (see
 * schema.ts). Not used by the app.
 */

export interface Envelope {
  _fictional: string;
  /** A components.schemas name, "array:<Name>", or "response:<operationId>:<status>". */
  schema: string;
  example: unknown;
}

const files = import.meta.glob<Envelope>('./*.json', { eager: true, import: 'default' });

/** Every fixture by file name without ".json". */
export const FIXTURES: Record<string, Envelope> = Object.fromEntries(
  Object.entries(files).map(([path, env]) => [path.replace(/^\.\//, '').replace(/\.json$/, ''), env]),
);

/** A deep copy of a fixture's example payload, typed by the caller (a wire type from adapters.ts). */
export function fixture<T>(name: string): T {
  const env = FIXTURES[name];
  if (!env) throw new Error(`No contract fixture "${name}"`);
  return structuredClone(env.example) as T;
}
