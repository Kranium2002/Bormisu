/**
 * Picks the data source once, from VITE_DATA_SOURCE: `api` (default) or `sample`.
 * This is the only module allowed to import src/sample/, and only behind the flag.
 */
import { createApiSource } from './apiSource';
import type { DataSource } from './DataSource';

/** The configured data source kind. Vite inlines the env value, so API builds drop the sample chunk. */
const KIND: DataSource['kind'] = import.meta.env.VITE_DATA_SOURCE === 'sample' ? 'sample' : 'api';

/** The configured data source kind. */
export function dataSourceKind(): DataSource['kind'] {
  return KIND;
}

/** Base path of the backend API, e.g. "/api/v1". */
export function apiBase(): string {
  return (import.meta.env.VITE_API_BASE || '/api/v1').replace(/\/$/, '');
}

/** Creates the configured data source. The sample module is loaded lazily, and only in sample mode. */
export async function createDataSource(): Promise<DataSource> {
  if (import.meta.env.VITE_DATA_SOURCE === 'sample') {
    const { createSampleSource } = await import('../sample/sampleSource');
    return createSampleSource();
  }
  return createApiSource(apiBase());
}
