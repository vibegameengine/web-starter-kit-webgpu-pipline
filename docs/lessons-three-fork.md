# The three fork: r182 plus the instance-velocity fix (2026-09-11)

## Why there is a fork

The village shimmered under TAA because stock three r182 writes the placement of every
static `InstancedMesh` into the velocity buffer (the mechanism and the numbers are in
[lessons-instance-velocity.md](lessons-instance-velocity.md)). Upstream fixed it in r183
— PR #32586 "InstanceNode: Support velocity", plus #32615 which repairs the UBO size and
attribute update it broke. We are pinned to r182 by the rest of the pipeline, so the
choice was our own override of the velocity channel or the upstream commits on top of
r182. The fork is the second, and it is better: upstream also keeps a per-mesh previous
instance matrix, so *moving* instances get correct motion vectors, which our override
never did.

## What exists

- `https://github.com/vibegameengine/three.js` — fork of `mrdoob/three.js`.
- Branch `r182-instance-velocity` = tag `r182` + cherry-picks `54a25079e` (#32586) and
  `b847bf44f` (#32615). Both applied without conflict.
- `vendor/three` — that branch, cloned blobless (`--filter=blob:none`) with a sparse
  checkout of `src`, `examples/jsm`, `build`. Gitignored like the other vendored repos.
- `vite.config.ts` aliases `three`, `three/webgpu`, `three/tsl`, `three/addons/*` and
  `three/examples/jsm/*` into `vendor/three/src` and `vendor/three/examples/jsm`.

`package.json` still depends on `three@^0.182.0`: it is what TypeScript reads for types,
and what anything outside Vite (the `tsx` fixtures) resolves. The two are the same
release apart from the two commits, so the types still describe the code.

## The ablation

`VITE_THREE_STOCK=1 npm run dev` drops the three aliases and serves the npm package.
That is the A/B, and it can fail: `node scripts/check-instance-velocity.mjs` against
such a server reports 118.594 px of velocity on a motionless scene and stops.

| | static instanced velocity | camera moving | shimmer /255 |
|---|---|---|---|
| `VITE_THREE_STOCK=1` (npm r182) | 118.594 px | 114.5 px | 2.84 |
| `vendor/three` fork | 0 px | 0.208 px | 0.42–0.57 |

## Traps

- **SSH, not HTTPS, for the push.** `gh` was authenticated as `vibegameengine`, but the
  git credential helper answered with another account and the push was refused with 403.
  `git remote set-url origin git@github.com:...` fixed it.
- **Sparse checkout in cone mode pulls the parent directories' files.** Asking for
  `examples/jsm` also brings every `examples/*.html`, and Vite's dependency scanner then
  tried to pre-bundle `three-gpu-pathtracer` and friends from those pages and refused to
  start. `optimizeDeps.entries: ['index.html']` pins the scan to our app.
- **Alias to `src`, not to `build/`.** The npm package's `.` and `./webgpu` entry points
  are two separate bundles; aliasing both to the same source tree means one copy of every
  class, and an edit in `vendor/three` shows up in the next frame.
- First dev boot after the switch takes ~60 s while Vite transforms three's ~500 source
  modules; it is 10.7 s warm, the same as before.

## Keeping it

To pull a later upstream fix: `git -C vendor/three fetch upstream`, cherry-pick onto
`r182-instance-velocity`, push. When the pipeline is ready to move to r186, the branch
and the alias go away together — check `Instance.js` upstream first, the fix has been
there since r183.
