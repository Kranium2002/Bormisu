/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config. `/api` is proxied to the FastAPI backend (default http://127.0.0.1:8000),
 * override with VITE_API_PROXY. `vite --mode sample` loads `.env.sample` (VITE_DATA_SOURCE=sample).
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY || 'http://127.0.0.1:8000';
  return {
    plugins: [react()],
    build: {
      // exceljs (~930 kB) is its own chunk, loaded only when someone exports an xlsx.
      chunkSizeWarningLimit: 1000,
    },
    server: {
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
    test: {
      include: ['src/**/*.test.{ts,tsx}'],
      environment: 'node',
    },
  };
});
