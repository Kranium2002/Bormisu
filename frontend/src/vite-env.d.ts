/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `api` (default) or `sample`. */
  readonly VITE_DATA_SOURCE?: string;
  /** Backend API base path, default `/api/v1`. */
  readonly VITE_API_BASE?: string;
  /** First map focus: `world` (default) or an ISO country code such as `DE`. `?focus=` wins. See src/geo/mapFocus.ts. */
  readonly VITE_MAP_FOCUS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
