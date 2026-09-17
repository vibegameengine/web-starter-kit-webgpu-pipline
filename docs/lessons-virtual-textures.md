# Virtual textures, stage 1a (2026-09-17)

Stage 1a of the virtual texture work: every lightmap chart
has its own pyramid down to a level that fits one tile; levels wider than a tile are cut
into equal 64² tiles with a 2-texel border from the same level; the first level that fits
is the chart's tail, packed once into a strip below the pool slots. The page table points
a non-resident tile at its nearest resident ancestor in the same chart, else at the tail.
Replaces the chart working atlas (`pagePool.ts`, `workingAtlas.ts`, `demand.ts`).

Code: `src/shared/gi/lod/chartPyramids.ts` and `tileResidency.ts` are pure and tested with
vitest (`npm test`); `tilePool.ts` is the GPU side and the shader read; `feedback.ts` the
request pass. URL: `?vtTile=` tile size, `?vtPool=` slots per side (16), `?vtEvict=all`
keeps every tile out of the pool, `?vtMutation=slot` shifts every page entry by one slot,
`?lod=0` reads the full atlas. Lab: GI bake folder, "LOD lab (scene | tile pool)".

## What the frames showed (`?scene=village-light`, one saved bake, baked-only)

- Tiles against the full atlas: 218 of 921600 pixels differ by more than 8/255.
- `?vtMutation=slot`: 250948 pixels differ, the walls show other tiles' light. The read
  path is live.
- `?vtEvict=all`: every surface on its tail, no black and no foreign light.
- A 16-slot pool on a seven-pose flight: the planner coarsens 36 to 168 tiles a pose, no
  pixel that is lit in the full atlas goes dark (`scripts/_vt_flight.mjs`).
- `leak-room` from inside: full atlas, tiles and forced eviction give the same frame. Weak:
  only one of its 31 charts is tiled. The cross-chart guarantee is the vitest case that
  fills two neighbouring charts with different constants and checks every tile and tail
  texel.

## Traps

- **Three's basic material multiplies colour by alpha.** The first request packing put the
  atlas y in alpha; red came back as chart x y, 33891 of 33907 fragments resolved to no
  tile, and the pool held 16 tiles for the village. Alpha is 1 now and chart and level
  share red.
- **The request target is a quarter of the frame, so its derivatives are four times
  larger.** Without dividing by the fragment size every surface asked two levels too
  coarse and landed on its tail.
- **Sixteen sampled textures per shader stage.** A fourth texture in the lightmap read
  (separate chart table and tail) made the village sand material's bind group layout
  invalid; the only console error named the pipeline, not the limit. Proved by sampling the
  tail from the pool texture instead: the error went away. The chart records now sit after
  the tile entries in the page table, and the tail inside the pool texture.
- **Tests written after the code passed first time.** Two mutations (no tile border, every
  non-resident entry pointed at the tail) each failed one test; without that there was no
  evidence the tests could fail.

## Open

- 1b: the pool is a render target filled by `copyTextureToTexture` from store pages that
  hold every tile on the GPU (40 MiB for village-light). Tiles do not live in tab memory
  yet and nothing streams from CPU.
- 1c: one level per read; coarse levels show brighter lines along chart edges.
- The tail texture is sized by powers of two and mostly empty (1024² for village-light).
