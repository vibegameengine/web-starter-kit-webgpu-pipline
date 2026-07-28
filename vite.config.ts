import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * Entry = jure/webgiya (surfel GI). Not the experimental hashBlur pipeline.
 * Repo vendored at vendor/webgiya — that is the correct render pipeline.
 */
export default defineConfig({
  root: fileURLToPath(new URL('./vendor/webgiya', import.meta.url)),
  publicDir: fileURLToPath(new URL('./vendor/webgiya/public', import.meta.url)),
  server: {
    port: 5188,
    host: '127.0.0.1',
    // http: webgiya's mkcert is optional; avoid HTTPS pain on Windows
    https: false,
  },
  preview: { port: 5188, host: '127.0.0.1' },
  resolve: {
    // hoist deps from monorepo root
    dedupe: ['three', 'lil-gui', 'three-mesh-bvh'],
  },
  build: {
    outDir: fileURLToPath(new URL('./dist-webgiya', import.meta.url)),
    emptyOutDir: true,
    target: 'esnext',
    sourcemap: true,
  },
  // root package node_modules
  cacheDir: fileURLToPath(new URL('./node_modules/.vite-webgiya', import.meta.url)),
});
