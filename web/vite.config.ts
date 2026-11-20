import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The app is built into dist/web and served by the Fastify server (same origin as the API: one cookie, one CSP).
export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  build: { outDir: path.resolve(import.meta.dirname, '../dist/web'), emptyOutDir: true, sourcemap: false },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3300', '/healthz': 'http://localhost:3300' } },
});
