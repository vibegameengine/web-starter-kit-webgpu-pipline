import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/** Old experimental FSD entry (src/app/main.ts) — not the production GI path. */
export default defineConfig({
  server: { port: 5190, host: '127.0.0.1' },
  resolve: {
    alias: {
      '@app': fileURLToPath(new URL('./src/app', import.meta.url)),
      '@widgets': fileURLToPath(new URL('./src/widgets', import.meta.url)),
      '@features': fileURLToPath(new URL('./src/features', import.meta.url)),
      '@entities': fileURLToPath(new URL('./src/entities', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  build: { target: 'esnext', sourcemap: true },
});
