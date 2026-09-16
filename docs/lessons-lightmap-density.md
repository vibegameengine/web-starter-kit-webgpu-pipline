# The start of a scene, the density of its lightmap, and what the pool actually limits

2026-09-16, branch `startup` off `pipeline-v3`, worktree `worktrees/startup`.

The complaint that started it: the village took 182.5 s to a settled frame cold and
75 s warm, and the loading screen showed three separate baking stages every launch.

## What the start was doing

One serial chain on the main thread, no frame until the last line:

    renderer → scene build → lightmap unwrap → static BVH → frame graph →
    contact BVH → lightmap bake (once per page) → probe bake → save → shaders → frame

Three things in that chain had no reason to be there.

**The contact tree.** A second, full-detail static BVH built on every launch for a pass
that has been off by default since 2026-09-09. The traced reflections read it too, which
is why it survived; they now read the GI's own tree (same four storage nodes, same
binding names `bvh` / `bvh_position` / `bvh_index` / `bvh_attribute`).

**The bake per page.** The atlas is a stack of 512² pages and each page was a separate
bake: a render with the other pages pushed out of clip space, a cleared radiance cache,
and its own 200-pass integration. Six beach pages were six bakes, and every page was also
denied the bounce off the texels of the others. Nothing required it — the pool limits
COVERED TEXELS, not pages, and the seeder, the denoiser and the blit have always taken a
height. This was fixed once before (`153a7de`) and reverted the same night by `eb689b1`
with an empty commit body; no reason for the revert is recorded anywhere in the tree or
in the agent feed.

**The density nobody chose.** `assignLightmapUvs` solved for the coarsest density that
fitted one 512 atlas: corridor 0.1156 m/texel, village 0.1087, beach 0.0691. The same
bench was baked at two different qualities in two scenes, and the quality was a
by-product of how much surface a scene happened to have.

## What replaced it

Density is a parameter (`?lmDensity=`, 0.05 m/texel by default) and the atlas grows in
pages to hold it — as many as the scene needs, capped by what one texture can be
(`floor(8192 / atlasSize)`).

That alone would move the cost onto the surfel pool, because a surfel per covered texel
means a finer atlas asks for proportionally more surfels for the same light, and
`MAX_SURFELS` is 262144 slots — 179 MiB on the GPU and the same again in host arrays. So
the light is measured on a lattice instead: one surfel every `?sample=` metres of world
surface (0.1 by default), counted from each chart's own corner, and carried to the texels
between them along the links `filterLinks` traces. The pool then pays for the spacing,
not for the resolution.

Measured, bake cache deleted before each cold run, headed Chrome, dev server:

| scene | pages | cold to steady | bake | warm |
|---|---|---|---|---|
| village | 4 | 80.3 s | 24.3 s, one pass | 22.5 s |
| beach | 2 | 37.5 s | 5.3 s | 17.8 s |
| corridor | 6 | 18.5 s | 4.1 s | 9.6 s |

Against 182.5 s cold and 75 s warm for the village before, at 0.1087 m/texel.

## Traps this cost

**A pixel count cannot tell two bakes apart.** The first A/B read 887k of 1.44M pixels
differing — and two runs of the *same* settings differed by 899k. The bake is stochastic;
at a threshold of one unit out of 255 the count measures the noise, not the change. What
separates them is the distribution: MAE 3.18 with p99 46.0 for the change against MAE
2.04 with p99 9.3 for the control. The median is identical (1.67) in both, so the
difference lives in a few per cent of the pixels — on edges and contact shadows. That
says the image moved, not that it improved; no oracle was run.

**A URL parameter switches off the saved GUI profile.** `config/gui-settings.json` is
applied only when the URL carries nothing but `scene`, `cam`, `hud` or `settings`. The
first comparison put the parameters on one arm only, so it compared two different
exposure profiles and reported it as a lighting change.

**The bake cache key was the scene name alone.** Changing the density restored an atlas
laid out for a different one: the unwrap addressed two pages through `uv1` while the
restored texture held six, every sample landed on the wrong page, and the frame looked
plausible and was wrong throughout. The key now carries the density, the sample spacing
and the atlas size.

**The link pass was square.** `createFilterLinks(size, attr)` with `texelCount = size *
size`, and a kernel that returned at `i >= side * side`. On a multi-page atlas every page
above the first kept a zero link mask, so the spread refused every neighbour there and
the gutter fill invented what the bake had not measured: 730687 invented against 165537
measured on the six-page corridor. With the height threaded through: links across 357034
of 357143 covered texels, 89706 measured, 262660 carried, and the padded texels are the
gutter around the charts rather than their interior.

**Removing the contact tree removed it from three consumers, not one.** `staticLight`
hands the same tree to `filterLinks` and to the probe bake. The GI tree demotes what does
not fit its 500k budget to cluster proxy boxes — the village's 1.8 M triangles stand
behind 706 of them — and a visibility ray between two lightmap texels starts on a surface,
therefore inside its own proxy box, therefore reads as blocked. The bake now builds a
full-detail tree of its own, lazily: 2315590 triangles in 4.3 s on the village, 53516 in
79 ms on the corridor, and a launch that restores the saved bake never calls it.

**The packer lost charts silently.** `packOnePage` returned an empty list of leftovers
when a chart was wider than a page, which read to the caller as "everything fitted": that
chart and every one after it kept `x = y = page = 0`, took a `uv1` anyway, and two charts
shared one rectangle. A fixed density cannot coarsen its way out of this the way the old
search could, so it throws with the widest surface the density and page size can hold.

**An estimate of the lattice is wrong in both directions.** Dividing coverage by the
stride squared undercounts on scenes of small charts; counting chart rectangles
overcounts by the four fifths of a rectangle that geometry never covers (corridor: 224056
counted against 89706 seeded). Pool exhaustion is exact instead — the seed kernel takes a
slot with an atomic add and skips the write past the end, so a pool that ran out ends at
exactly its capacity — and a lower bound is refused before the bake rather than after 200
integration passes.

## Open

- The runtime half of the design is not built: the page stack is resident whole, and the
  frame does not stream the mip a chart is seen at into one resident atlas.
- 80097 of the village's 632414 covered texels are still black after the spread, in charts
  whose links are isolated. Not diagnosed.
- The lattice spacing is uniform in *atlas* space, so on a projected chart tilted past 45°
  the world spacing between samples is larger than `stride × metresPerTexel` by `1 / cos θ`.
- No oracle for the light itself. The number that would settle whether the lattice plus
  spread is as good as a surfel per texel is the MAE between those two atlases, and it has
  not been measured.
- `?scene=leak-room` has not been re-run since any of this.
