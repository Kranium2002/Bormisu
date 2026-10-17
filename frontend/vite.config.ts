/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';

/** DIN 4023 pattern assets at the repository root, shared with the backend (imported as `@din/...`). */
const DIN_DIR = fileURLToPath(new URL('../assets/din4023_patterns', import.meta.url));

/**
 * Vite config. `/api` is proxied to the FastAPI backend (default http://127.0.0.1:8000),
 * override with VITE_API_PROXY. `vite --mode sample` loads `.env.sample` (VITE_DATA_SOURCE=sample).
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY || 'http://127.0.0.1:8000';
  return {
    plugins: [react()],
    resolve: {
      alias: { '@din': DIN_DIR },
    },
    build: {
      // exceljs (~930 kB) is its own chunk, loaded only when someone exports an xlsx.
      chunkSizeWarningLimit: 1000,
    },
    server: {
      // The dev server may read the shared DIN assets outside frontend/.
      fs: { allow: [searchForWorkspaceRoot(process.cwd()), DIN_DIR] },
      proxy: {
        // SSE (/api/v1/events) and the chat stream pass through unbuffered: the proxy streams by default.
        // changeOrigin false keeps the browser's Host, so the backend's CSRF check (Origin must match the
        // request's own host, as behind nginx) accepts a dev server on any port.
        '/api': { target: apiTarget, changeOrigin: false },
      },
    },
    test: {
      include: ['src/**/*.test.{ts,tsx}'],
      environment: 'node',
      // Cold runs on slow machines (the xlsx export test loads exceljs) can pass the 5 s default.
      testTimeout: 30_000,
    },
  };
});
