# Lightmap LOD on the original bake (2026-09-17)

The LOD streaming from the `lod-pages` branch (`src/shared/gi/lod/`, `src/widgets/lod-lab/`) now
sits on top of the original one-pass bake. The bake writes charts at the chosen density into as
many 512-square pages as the scene needs; `LightmapLod` cuts every chart out of those pages into a
mip chain (`PagePool`, 2048-square source pages), and the materials read one 512-square working
atlas (`WorkingAtlas`) filled from the levels the drawn frame asked for (`DemandFeedback`, a
quarter-resolution pass writing chart id and `log2` of the uv1 derivative). It is the default;
`?lod=0` makes the materials read the full stacked atlas directly. The tracer and the split view
still read the full atlas, because they address it by the baked uv1.

## What was measured

- `scripts/_lod_check.mjs` on `?scene=village-light` with one saved bake: the baked-only frame
  through LOD and through `?lod=0` differ by more than 8/255 on 4219 of 921600 pixels, all of
  them one-pixel strips on chart edges and walls at grazing angles, where the frame itself asks
  for a coarser level. Two LOD launches differ on 0 pixels.
- `scripts/_lod_fps.mjs`: 235-240 requestAnimationFrame ticks per 2 s with and without LOD.
- `lmDensity=0.04` gives 7 bake pages; the LOD frame reads the right charts from all of them.

## Traps

- **The first seconds after the loading overlay hides are shader warm-up.** The frame loop ran 4
  frames in 4.5 s there, the first readback was still pending and the feedback reported zero
  charts asked. It looked like a dead demand pass; 400 frames later 50 charts were asked and
  resident. Wait for frames, not for the overlay, before reading `__lod`.
- **Two `?bakeCache=0` launches are two different bakes.** Their baked-only frames differ by
  noise across every surface (124299 pixels), which buries anything LOD does. Compare LOD against
  `?lod=0` on one saved bake.
- A chart wider than a 512 page still refuses the layout (`lmDensity=0.035` and `0.02` on
  village-light). That is the packer's limit, not LOD's.
