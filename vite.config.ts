import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { bakeCachePlugin } from './scripts/bake-cache-plugin.mjs';
import { guiSettingsPlugin } from './scripts/gui-settings-plugin.mjs';
import { feedComments } from './dashboard/vite.feed-comments.ts';
import { feedAgents } from './dashboard/vite.feed-agents.ts';

/**
 * @important The fiber fork resolves to its SOURCE, not to `dist`: we expect to patch
 * it, and a source alias makes an edit in `vendor/react-three-fiber` show up in the
 * next frame instead of after a package build. Its patched react-reconciler is the one
 * build step that still has to be run by hand — `npm run fiber:reconciler`.
 */
const fiberSource = fileURLToPath(new URL('vendor/react-three-fiber/packages/fiber/src/index.tsx', import.meta.url));

/**
 * @important three resolves to `vendor/three`, our fork of mrdoob/three.js, branch
 * `r182-instance-velocity` = the r182 tag plus the two upstream commits that teach
 * InstanceNode to carry a previous instance matrix (#32586, #32615 — they landed in
 * r183). We are pinned to r182 by the rest of the pipeline, and the alternative to a
 * fork was our own override of the velocity channel. Source, not `build/`: the point is
 * to be able to patch it and see the next frame.
 */
const threeSource = (file: string) => fileURLToPath(new URL(`vendor/three/src/${file}`, import.meta.url));
const threeAddons = fileURLToPath(new URL('vendor/three/examples/jsm/', import.meta.url));
const forkedThree = process.env.VITE_THREE_STOCK === '1' ? [] : [
  { find: /^three\/webgpu$/, replacement: threeSource('Three.WebGPU.js') },
  { find: /^three\/tsl$/, replacement: threeSource('Three.TSL.js') },
  { find: /^three\/addons\//, replacement: threeAddons },
  { find: /^three\/examples\/jsm\//, replacement: threeAddons },
  { find: /^three$/, replacement: threeSource('Three.js') },
];

/**
 * Entry = the Elderwood pipeline in `src/` (FSD, see CLAUDE.md §2).
 * webgiya is kept vendored and runs under `npm run dev:gi` for A/B only —
 * it is the donor of the WGSL BVH traversal, not the application.
 */
export default defineConfig({
  plugins: [react(), bakeCachePlugin(), guiSettingsPlugin(), feedComments(), feedAgents()],
  define: {},
  server: { port: 5188, host: '127.0.0.1', watch: { ignored: ['**/public/bakes/**', '**/config/gui-settings.json*'] } },
  preview: { port: 5188, host: '127.0.0.1' },
  resolve: {
    dedupe: ['three', 'lil-gui', 'three-mesh-bvh', 'react', 'react-dom'],
    alias: [
      { find: '@vibegameengine/react-three-fiber', replacement: fiberSource },
      { find: '@react-three/fiber', replacement: fiberSource },
      ...forkedThree,
    ],
  },
  optimizeDeps: { entries: ['index.html'], exclude: ['three'] },
  build: { target: 'esnext', sourcemap: true },
});
