# Village frame: CPU, not GPU (2026-09-17)

`midsee-village` ran at 60 fps at 1600x900 while the GPU spent 5 ms a frame. The time was on
the main thread, in two places.

## 1. The lightmap LOD demand pass drew the whole scene

`DemandFeedback` rendered every mesh with its override material each frame: trees, flowers,
water, the boat, none of which have a chart. 14.1 ms a frame against 9.3 with `?lod=0`. Charted
static meshes now carry `Layer.LightmapDemand` and the pass renders that layer alone: 9.4 ms,
86 charts still asked. Objects without a chart no longer occlude charts behind them in the
request, which costs atlas room and not correctness.

## 2. The shadow pass recomputed every material cache key every frame

`__shadowAutoUpdate(false)` (stop redrawing the 8192 shadow map) took the frame loop from 10.3 to
5.6 ms, for 174 draws. A CDP profile diff (`scripts/_profile_diff.mjs`, ON minus OFF) put 3 ms of
it in `RenderObjects.get -> getCacheKey -> getMaterialCacheKey`. three's `renderObject()` copies
each object's `alphaTest` into the shared override material through the setter, and the setter
bumps `version` whenever the value crosses zero; the shadow pass alternates alpha-tested foliage
and opaque walls, so the version moved on nearly every draw and every render object re-keyed.
Fork commit 7d3343686 (`vibegameengine/three.js`, `r182-instance-velocity`) moves the override's
version only when a source material's own version changes: frame loop 10.3 -> 6.8 ms, interval
11.5 -> 8.8 ms. A still frame at `cam=front` differs from the old renderer on 797 of 1440000
pixels, max 15/255, all in the animated water.

## Tools

- `__frameCpu(frames)` wraps the animation loop and reports the median CPU time of the callback
  and the rAF interval. The inspector's per-pass `cpu` column is not a duration and cannot answer
  this.
- `__drawCounts(frames)` counts backend draws per render target and names the objects.
- `__shadowAutoUpdate(bool)` is the shadow-redraw ablation.
- `scripts/_frame_cpu_ablate.mjs`, `scripts/_profile_diff.mjs` (`ON=` / `OFF=` expressions),
  `scripts/_draw_counts.mjs`, `scripts/_fps_why.mjs` (URL variants), `scripts/_shot_still.mjs`.

## Traps

- Any URL parameter besides `scene`, `cam`, `hud`, `settings` drops `config/gui-settings.json`; a
  baseline for an ablation needs a dummy parameter (`&zz=1`) so both sides use code defaults.
- A still frame without the saved settings is badly over-exposed; compare at `exposureEV=-2.5`.

What is left at 8.8 ms: ~5 ms GPU and ~6.8 ms of the loop's CPU, most of it the 182 draws of the
main pass and the post chain.
