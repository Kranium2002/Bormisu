/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `api` (default) or `sample`. */
  readonly VITE_DATA_SOURCE?: string;
  /** Backend API base path, default `/api/v1`. */
  readonly VITE_API_BASE?: string;
  /** Product name shown in the UI, default "Bormisu". */
  readonly VITE_APP_NAME?: string;
  /** Basemap tile URL template, default the OpenStreetMap standard tiles. */
  readonly VITE_TILE_URL?: string;
  /** Basemap attribution (HTML), default the OpenStreetMap attribution. */
  readonly VITE_TILE_ATTRIBUTION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
