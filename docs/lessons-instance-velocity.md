# TAA shimmer on the village: InstancedMesh velocity in three r182 (2026-09-11)

## The report

The village shimmered under TAA; the beach and the forest did not. The suspicion handed
over was instancing: the village is built from `InstancedMesh` through
`shared/fiber/MultiInstances.tsx`, the beach is plain meshes plus `installVertexMotion`
foliage, the forest clones its trees as plain meshes.

## The cut that settled it

One boot, still scene (`?still=1`), three measurements of the same `velocity` target
through `__fog.velocityFrame()`, hiding one class of mesh at a time
(`scripts/_village_velocity.mjs`):

| visible meshes | moving pixels (> 0.05 px) | mean velocity |
|---|---|---|
| everything (85 instanced, 96 plain) | 16.1 % | 34.8 px |
| plain meshes only | 0 % | 0 px |
| instanced meshes only | 25.4 % | 50.4 px |

A motionless village writes 50 px of velocity from its instances and exactly nothing
from its plain meshes. No further search was needed.

## Why

`VelocityNode.setup()` in three r182:

```js
const clipPositionCurrent  = projectionMatrix.mul( modelViewMatrix ).mul( positionLocal );
const clipPositionPrevious = this.previousProjectionMatrix.mul( previousModelViewMatrix ).mul( positionPrevious );
```

`positionPrevious` is `positionGeometry.toVarying('positionPrevious')` — the raw
geometry position. `positionLocal` is a property that `InstanceNode` **assigns** in the
vertex stage: it already carries `instanceMatrix`. So the current position is the
instance's, the previous one is the untransformed prototype's, and the difference — the
whole placement of the instance in its prefab — is reported as motion. TAA then fetches
history from those pixels and the geometry crawls.

This is the same class of bug `vertexMotion.ts` already documented for wind-displaced
foliage: a previous position that does not match how the current one was built. r183
handles the instanced case upstream; r182 does not.

## The fix

First ours: `installStaticMotion(material)`, projecting `positionLocal` — instance
transform included — with both unjittered view-projections, installed by
`MultiInstances`. It worked (0 px, shimmer 2.84 -> 0.53 /255, frame cost unchanged at
0.53 ms) but covered only static instances.

It was then replaced by the upstream fix, taken through a fork of three: `vendor/three`,
branch `r182-instance-velocity` = r182 plus #32586 and #32615, which give `InstanceNode`
a per-mesh previous instance matrix and therefore handle moving instances too. The local
override is gone; `VITE_THREE_STOCK=1 npm run dev` is the ablation. See
[lessons-three-fork.md](lessons-three-fork.md).

Measured on `?scene=village-light` (`node scripts/check-instance-velocity.mjs`):

| | static mean velocity | moving pixels | shimmer (max frame-to-frame, /255) | camera moving |
|---|---|---|---|---|
| stock three r182 (`VITE_THREE_STOCK=1`) | 118.6 px | 15.4 % | 2.84 | 114.5 px |
| fork | 0 px | 0 % | 0.42–0.57 | 0.21 px |

Camera motion still produces velocity — that column is the guard against "fixing" the
shimmer by writing zero everywhere, which would make TAA smear on every pan.

Frame cost, GPU ms median of 150 frames at 1600x900 (`scripts/_instance_motion_cost.mjs`,
two runs each): 0.53 ms with the ablation, 0.53 ms with the fix. The node replaces
three's velocity arithmetic rather than adding to it.

## Traps met on the way

- **A stalled frame loop makes any temporal metric pass.** The first shimmer run
  reported 0.005 against 0.010 — both essentially zero — because the frames were not
  advancing in the unfocused window. The check now collects the TAA jitter each sample
  and asserts more than one distinct value before trusting the number.
- **A 90-second scene is not a test rig.** The full village boots in ~90 s (2.3 M
  triangles of contact BVH, 2109 m² of lightmap, the water simulation settling), so a
  four-boot measurement was a ten-minute loop and the user stopped it. `?scene=village-light`
  (`src/widgets/world/villageLightScene.tsx`) is one house plus the instanced windows and
  a ground slab, same `MultiInstances` path, same materials: 12 s warm, and the defect
  reproduces on it at 118 px.
- **The bake cache only exists if the dev server has `bakeCachePlugin`.** A worktree
  that kept the committed 13-line `vite.config.ts` re-baked the probes on every boot
  (45 s instead of 12 s) and looked like a slow scene rather than a missing plugin.

## Open

- The fork is pinned to r182; moving to r186 removes the branch and the alias together.
- `package.json` still carries `three@^0.182.0` for types, so a type-level change in the
  fork would not be visible to TypeScript.
