import { defineConfig } from 'vite';

/**
 * Entry = the Elderwood pipeline in `src/` (FSD, see CLAUDE.md §2).
 * webgiya is kept vendored and runs under `npm run dev:gi` for A/B only —
 * it is the donor of the WGSL BVH traversal, not the application.
 */
export default defineConfig({
  server: { port: 5188, host: '127.0.0.1' },
  preview: { port: 5188, host: '127.0.0.1' },
  resolve: { dedupe: ['three', 'lil-gui', 'three-mesh-bvh'] },
  build: { target: 'esnext', sourcemap: true },
});
