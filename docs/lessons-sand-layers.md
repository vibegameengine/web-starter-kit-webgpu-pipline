# Lessons — the layered sand material (iteration 27)

Porting `web-starter-kit`'s WebGL layered-terrain material to TSL/WebGPU and putting
the beach's sand on it. What follows is what the port cost, measured, not a summary
of the code.

## What the port is

`src/shared/render/terrain/` holds the technique, free of any beach:

- `layerMaps.ts` — a layer is TWO RGBA textures, `surface` = albedo.rgb + relief.a
  and `detail` = normal.xy + ranked coverage.z. Seven channels, two taps per cell,
  and the normal's z comes back from its own x and y.
- `layerSampler.ts` — the stochastic read: a quarter turn and an offset per cell,
  four neighbouring cells resolved, every lookup through explicit gradients of the
  SMOOTH uv. Plus a `plain` read for layers whose pattern has a direction.
- `layeredSurface.ts` — the stack: `base`, `weight`, `height`, `alpha` (a lid) and
  `overlay` (laid over the finished stack by its own ranked coverage), plus
  parallax and the contact shadow that makes a shell lie ON the sand.

`src/entities/island/` supplies the beach's four layers — dry grain, wind ripples,
wet packed sand, shell litter — their masks (the water's wetness field, height above
the waterline, drift noise) and their maps.

## Three defects, each found by cutting the thing in half

**1. `textureSampleGrad` drops the array layer.** The first port used one
`DataArrayTexture` per map kind and `texture(map, uv).grad(dx, dy).depth(i)`. Three's
WGSL builder emits `textureSampleGrad(texture_2d_array<f32>, sampler, vec2, vec2,
vec2)` — no array index, its own TODO in `WGSLNodeBuilder.generateTextureGrad` — and
the shader fails to compile. `generateTextureLevel` drops it too. So an array slice
can be read EITHER by layer OR with a controlled footprint, not both. Hence two plain
2D textures per layer; the packing above is what keeps that from costing four taps.

**2. Ties in the ranked coverage.** A scatter map is mostly empty. Ranking equal
values by their position in the sort spread those zeros over the whole 0..1 range, so
a cut at `1 - density` landed in the middle of the empty texels: at a stated density
of 0.055 the litter covered about 30 % of the ground in pale blobs. With ties sharing
a rank, `node scripts/check-sand-maps.mjs` reports 5.50 % for 0.055 and 18.46 % for
0.2 — the density is the number it says it is.

**3. A plain bilinear cell blend cancels what the variants carry.** The four cell
variants are the same map under different quarter turns. Averaging them left the
ripple layer's blended normal within ±0.03 of straight up — the beach rendered as
smooth as poured cream while the ripple layer's own map measured ±0.36 in x. Each
corner is now weighted by its own relief (`exp(6·(h−0.5))` × its bilinear area), so
the tallest variant takes the pixel, the way the layers themselves height-blend.

## What was tested on its own, and how

- **The maps**: `scripts/check-sand-maps.mjs` writes every slice's albedo, relief and
  coverage as PNGs and prints the share of the map each density covers. A generator
  defect is visible there without a renderer.
- **The normal path into the lighting**: `?sandTilt=±0.8` tilts the whole sand normal
  by a constant. Sand-only crop mean 170.8 against 136.4 — the material's normal
  reaches the sun, so a flat-looking beach is the layer's fault, not the pipeline's.
- **The layers themselves**: `?sandView=weights|wet|normal|shade|albedo|ripple` paints
  the stack's own quantities as EMISSIVE. Emissive, not albedo: a debug view
  multiplied by the sun and the palms' shadows says as much about the shadows as
  about the layer being looked at.
- **Ablations**: `?sandRipples=0`, `?sandLitter=0`, `?sandGrainN=0`, `?sandRippleN=`,
  `?sandLitterDensity=`.

## What still reads wrong, and why

- **Detail below a pixel is noise.** A hard height blend read from a mip-averaged
  relief flips between two layers per pixel, and the beach seen from the diorama's
  default camera came out stippled like coarse fabric. The blend's sharpness and the
  normal tilt now both scale with `detailSharpness` — the same relaxation the
  overlay's cut already had.
- **Litter is a drift, not a coverage.** At 8 % everywhere the sand read as a car
  park. It is now 5 % inside a drift mask that follows the strand line.
- **Ripples are honest and therefore subtle.** Real 1–2 cm ripples under a sun at 53°
  give a few per cent of shading contrast. The reference photo's ripples are lit by a
  low sun. Nothing here fakes that.
