import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * Reference-only entry: jure/webgiya surfel GI, vendored.
 * Runs on a separate port so it can be A/B'd against the real pipeline.
 */
export default defineConfig({
  root: fileURLToPath(new URL('./vendor/webgiya', import.meta.url)),
  publicDir: fileURLToPath(new URL('./vendor/webgiya/public', import.meta.url)),
  server: { port: 5189, host: '127.0.0.1', https: false },
  preview: { port: 5189, host: '127.0.0.1' },
  resolve: { dedupe: ['three', 'lil-gui', 'three-mesh-bvh'] },
  build: {
    outDir: fileURLToPath(new URL('./dist-webgiya', import.meta.url)),
    emptyOutDir: true,
    target: 'esnext',
    sourcemap: true,
  },
  cacheDir: fileURLToPath(new URL('./node_modules/.vite-webgiya', import.meta.url)),
});
