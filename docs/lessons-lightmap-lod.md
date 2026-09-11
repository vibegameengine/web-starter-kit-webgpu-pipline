# Lightmap LOD: a GPU page pool and a working atlas assembled for the view

2026-09-11. `?lod=1`. Source: `public/lighting-streaming-design.html` (the revision that
moved the source pages onto the GPU), plus the user's summary: near pages stay in fast
access inside the VRAM budget, the rest live elsewhere, the atlas is assembled from
pages for the current view, and what is in front of the camera gets the most space.

## What was built

- `src/shared/gi/lod/pagePool.ts` — every chart's own mip chain, built chart-locally in
  linear space, each level blitted with a 4-texel edge-clamped gutter and packed into
  GPU page textures (default 2048², half float). The corridor's 636 charts fit in one
  page: 32 MiB.
- `src/shared/gi/lod/workingAtlas.ts` — the atlas the material actually reads. A render
  target (default 512²) divided into 32-texel cells; a chart-mip occupies
  `ceil((w+8)/32) × ceil((h+8)/32)` cells. Filled by `renderer.copyTextureToTexture`
  from the pool — GPU to GPU, no pixels through the CPU. A 4-column RGBA32F table gives
  the shader the chart's rect in map space, its resident mip and slot, and its root.
- `src/shared/gi/lod/demand.ts` — the plan. Visible charts are sorted by screen texel
  density, served in that order, and coarsened one mip at a time when the remaining
  cells do not fit. That is what makes the near surface win the space.
- `src/widgets/lod-lab/index.ts` — `?lodLab=1`, scene left, the working atlas read back
  from the GPU on the right with the resident slots outlined by mip and the plan's
  numbers.

## Measured

Corridor, `?cam=bench`, 636 charts, baked density 0.1323 m/texel:

| working atlas | resident charts | wanted cells | granted | coarsening steps |
|---|---|---|---|---|
| 1024² (4 MiB) | 267 of 267 visible | 414 | 414 | 0 |
| 512² (2 MiB) | 136 | 414 | 256 | 512 |
| 128² (0.1 MiB) | 2 | 420 | 16 | 1109 |

Midsee village, `?cam=front`, 84 charts: 357 cells wanted, 256 granted, 153 coarsening
steps, 32 copies per frame — the copy budget is saturated, so that scene churns.

**Correctness**: at 1024² every visible chart is resident at mip 0 and the frame matches
the old resident-atlas path to a mean of 2.0/255, against a run-to-run noise floor of
6.6/255 measured between two identical resident loads (`scripts/_lod_ab.mjs`). The A/B
is only meaningful with that floor next to it.

**The ablation that proves the branch is alive**: `?lodAtlas=128`. The picture visibly
collapses to flat per-chart colours because almost everything falls back to its root.
A zero A/B would have looked exactly like a dead branch.

## Traps paid for

- **Colour space silently ate 5% of the light.** The working atlas is a `RenderTarget`,
  and its texture does not default to the linear space a `DataTexture` gets. The LOD
  frame came out uniformly darker — signed mean −12.5/255, with no spatial structure.
  A uniform sign in the diff is the signature: a sampler bug bends geometry, a colour
  space bug shifts everything. `texture.colorSpace = THREE.NoColorSpace` on both the
  pool pages and the working atlas.
- **Roots are what keep a frame from going black**, and they have to be copied before
  the first frame and never evicted. Their cells are marked used for good.
  `renderer.initTexture(target.texture)` is needed before copying into a render target
  that has never been rendered to.
- **A chart's bounding box is not its area.** Splitting charts by connected islands
  (the same day's unwrap fix) produced islands whose bbox spans metres while their
  triangles cover no texel centre at all; the bake's UV rasterisation drew nothing and
  `padLightmapCharts` refused to invent light for them. The layout now runs the exact
  texel-centre coverage test on the CPU and rehomes what cannot hold a texel.

## Open

- One resident level per chart, not per tile: a chart is either at its wanted mip or at
  its root. The design's 128-texel tiles with tail packing are not implemented.
- No feedback pass. Demand is computed on the CPU from chart bounds, so a chart that is
  only visible through a reflection or a thin sliver is not counted.
- No transition blending: a chart swaps mip in one frame, which TAA will smear.
- Copy budget saturation on midsee means thrashing; there is no hysteresis yet.
- The pool is built from the baked atlas pixels on the CPU at boot. Pages are not yet
  produced by the baker directly on the GPU, and nothing spills to FS/HTTP/RAM.
