import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { bakeCachePlugin } from './scripts/bake-cache-plugin.mjs';
import { guiSettingsPlugin } from './scripts/gui-settings-plugin.mjs';
import { existsSync } from 'node:fs';

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

/* @important Port 5188 belongs to the root checkout alone. Worktrees used to inherit it and win it by
   accident whenever the root server restarted, so the browser kept loading another branch's bytes from
   the address the root tree was being edited at - read as a frozen transform cache for a whole evening.
   The root binds 5188 strictly and fails loudly on a conflict; a worktree derives a stable port of its
   own from its folder name and is free to slide off a collision. Override either with --port. */
const treeDirectory = fileURLToPath(new URL('.', import.meta.url));
const worktreeName = treeDirectory.replace(/[\\/]$/, '').split(/[\\/]/).slice(-2).join('/').match(/worktrees[\\/](.+)$/)?.[1];
const isRootTree = worktreeName === undefined;
const worktreePort = 5200 + ([...(worktreeName ?? '')].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) % 90, 7));
const devPort = isRootTree ? 5188 : worktreePort;

/* @important The agent feed plugins are optional. `dashboard/` is untracked and local to
   whoever runs the feed, and on 2026-09-16 it was found empty in the root checkout: the two
   static imports then failed to resolve, the config failed to load, and `npm run dev`
   refused to start for every session sharing this tree. A missing dashboard now costs the
   feed, not the renderer. */
async function feedPlugins() {
  const comments = fileURLToPath(new URL('dashboard/vite.feed-comments.ts', import.meta.url));
  const agents = fileURLToPath(new URL('dashboard/vite.feed-agents.ts', import.meta.url));
  if (!existsSync(comments) || !existsSync(agents)) return [];
  const [{ feedComments }, { feedAgents }] = await Promise.all([import(comments), import(agents)]);
  return [feedComments(), feedAgents()];
}

export default defineConfig(async () => ({
  plugins: [react(), bakeCachePlugin(), guiSettingsPlugin(), ...(await feedPlugins())],
  define: {},
  server: { port: devPort, strictPort: isRootTree, host: '127.0.0.1', watch: { ignored: ['**/public/bakes/**', '**/config/gui-settings.json*'] } },
  preview: { port: devPort, strictPort: isRootTree, host: '127.0.0.1' },
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
}));
