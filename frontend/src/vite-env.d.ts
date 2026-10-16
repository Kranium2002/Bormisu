/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `api` (default) or `sample`. */
  readonly VITE_DATA_SOURCE?: string;
  /** Backend API base path, default `/api/v1`. */
  readonly VITE_API_BASE?: string;
  /** Region the Map screen is restricted to: `DE` (default) or `world`. See src/geo/mapFocus.ts. */
  readonly VITE_MAP_FOCUS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
