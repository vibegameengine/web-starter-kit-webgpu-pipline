# Physical sky atmosphere (2026-09-17)

## What was built

`src/shared/render/sky/` is a physically based sky in the manner of Hillaire, "A Scalable and
Production Ready Sky and Atmosphere Rendering Technique" (EGSR 2020). Unreal Engine 5.8's
`SkyAtmosphere.usf` was read for how the idea is organised; nothing was copied from it. The
coefficients are Earth measurements from the paper's table 1.

- `atmosphereParameters.ts`: Earth defaults in kilometres, written to uniforms.
- `atmosphereMedium.ts`: Rayleigh, Mie and ozone density, phase functions (Cornette-Shanks for
  aerosols), ray-sphere distances.
- `lutMapping.ts`: the transmittance LUT's (height, zenith) mapping and the sky-view mapping.
- `scatteringMarch.ts`: the single-scattering march that all three LUTs share. It uses the
  analytic in-segment integral and adds a ground bounce.
- `atmosphereLuts.ts`: three compute kernels. Transmittance is 256x64 with 40 steps.
  Multi-scattering is 32x32 with 64 Fibonacci directions x 20 steps. The sky view is 256x160
  with 32 steps.
- `skyAtmosphere.ts`: the background node (sky view plus a limb-darkened sun disc) and the sun
  light's colour from CPU transmittance (`sunTransmittance.ts`).
- `skyEnvironment.ts`: rewrites the loaded panorama in place from the atmosphere, without the
  sun disc. The bake, the probes, the reflections and the fog then see the sky the frame shows.

`features/render-pipeline/skyStage.ts` wires it into the frame: GUI folder `Sky`, hook `__sky`,
URL `?sky=0|1 skyAltitude= sunDiscScale= skyEnvironment=0`. A host opts in with `sky: {}`.
`?scene=sky` is the lab (R3F: plinth, colonnade, white and mirror spheres, obelisk), with a card
and time-of-day chips in the home catalog. The check is `scripts/check-sky.mjs` (`PORT= CAM=
SHOTS=name:elevation,... QUERY= SETTLE=`). It runs headed and fails on the first page error.

## Where it departs from Unreal, on purpose

- **64 sphere directions for the multi-scattering LUT.** Unreal's default takes 2 and names the
  64-sample path "high quality". The LUT is computed once per atmosphere change, so the extra
  cost is paid once.
- **The sky view stores only 0..pi of relative azimuth.** The sky is mirror-symmetric about the
  sun's vertical plane. A square-root column law puts texels next to the sun, where the aerosol
  glow changes fastest.
- **The sun disc has limb darkening** (Hestroffer and Magnan 1998 power law, per channel). A
  flat disc is what engines usually draw.
- **The sky is the environment.** The panorama texture is overwritten in place, so no consumer
  is rebound and the lit scene matches the visible sky.

## Traps

- **A mirror sphere reflecting pale blue at sunset is not a failure.** It faces away from the
  sun, the anti-solar sky is blue, and auto exposure lifts the dark frame. The A/B
  (`skyEnvironment=1` against `=0`) differs only by the panorama's sun glint. A red fill of the
  panorama data proved the re-upload reaches the reflections.
- **The bake cache is keyed by scene name, not by sun or sky.** A lab launched with another
  `sunEl` restores the lighting baked at the first launch. The catalog chips carry
  `bakeCache=0`, and the plinth bakes in seconds. The first bake of `?scene=sky` ran before the
  environment rewrite existed; that file was deleted.
- **The panorama loader sets flipY**, so row 0 of the data is the top of the sky. The kernel
  writes v = 1 - y.
- `texture(...).level(0)` does not typecheck in TSL; it needs `level(float(0))`.
- The worktree's committed `tsconfig.json` has no `jsx`, and the root's does. Copy the root's
  in before running `tsc` on anything that imports a `.tsx`.

## Clouds (step 1 of 3)

`cloudNoise.ts` builds two tiling volumes by compute at first use: a 96³ shape volume (Perlin-Worley
billow, Worley carve, low gradient noise used as the weather map) and a 32³ Worley detail volume.
Every lattice is hashed modulo its period, so both wrap without a seam. `cloudDensity.ts` is a
cumulus layer (1.5 km base, 2.5 km thick) with a flat-bottom, round-top height profile and coverage
as an erosion threshold. `cloudLighting.ts` marches 48 steps with 6 steps toward the sun, a
dual-lobe Henyey-Greenstein phase, octave multiple scattering, sky ambient taken from the sky-view
LUT, and a ground bounce under the bases. `cloudLayer.ts` renders at half resolution with Halton
sub-pixel jitter and interleaved gradient noise per frame. The history is reprojected by direction,
and `composite()` puts the result over the sky in the background node. GUI folder `Clouds`, URL
`?clouds=0 cloudCoverage= cloudRes=`, `__sky.clouds` holds the live settings, and
`scripts/_cloud_sweep.mjs` (`VARIANTS=` JSON) captures variants and reports fps.

- **Octaves halving per step, as published, left a thick deck black underneath at noon.** The
  extinction scales are now 1, 1/4 and 1/20, with weights 1, 0.7 and 0.45.
- **A `select` does not skip work on the GPU.** The light march now sits behind `If(extinction > 0)`,
  and a `Break` ends the ray at 1 % transmittance. The first version drew 44.8 fps at 1600x900. The
  later "120 fps" was the vsync cap and measured nothing. The harsh-critic run measured with vsync off:
  +0.66 ms at coverage 0.73, +2.3 ms at 0.3 under an 8 degree sun, and +3.8 ms for that case at
  2560x1440.
- **A deep deck lit only by octaves reads as a dark blue veil.** The octaves die exponentially,
  which leaves the base lit by the blue sky alone. A two-stream diffuse transmission term,
  1 / (1 + 3/4 tau (1 - g)), weighted in only at large optical depth, turned overcast grey-white and
  greyed the cumulus bases as well.
- **Coverage used directly as the erosion threshold floods the noise.** At 0.85 the threshold fell
  to 0.15 and every billow filled in, leaving no structure. The threshold is now
  1 - 0.75 x coverage, and the default coverage moved from 0.55 to 0.73 to keep the same look.
- A cloud 1.5 km straight overhead is soft at half resolution. Horizon views are not.

## What the harsh-critic run of 2026-09-17 found, and what changed

- **Moving the sun left the bake lit by the old sky** while the lab card promised the opposite. The
  Sky folder now shows the bake status, and "bake light from this sky" (`__skyBake.bakeFromSky`)
  waits for two captures before it bakes. Reflections and fog take a new ambient after every
  capture. A fresh bake records its provenance even with `bakeCache=0`; before this, the status
  read "provenance unknown" and staleness was never shown.
- **A per-channel clamp at 20000 flattened the sun disc to white.** The ceiling now scales the
  colour as a whole, at `discPeak` (0.6) times the sun's illuminance. At sunset under auto exposure
  the disc is still near white on screen, so limb darkening is not claimed as visible.
- **The cloud targets never followed a resize, and their history never reset.** The targets are
  now sized for the display, the traced area is a uniform, and the history drops on any resize,
  settings change or skipped frame.
- **A fixed 45 km haze dissolved distant clouds into whatever lay behind them.** From 12 km the
  whole layer vanished into the ground. The air between camera and cloud now comes from the
  transmittance LUT, and the layer reaches the horizon.
- **The clouds read the camera matrix before `updateMatrixWorld`.** The sky update now runs after it.
- The multi-scattering LUT was written at texel centres and read at texel edges; both now use edges.
  The sky view recomputed on any 1 cm of vertical camera motion; the threshold is now 1 m.
- A failed capture is reported with a warning instead of stopping the render loop. Switching the sky
  off returns the sun to white.

## Clouds in the lighting (step 2 of 3)

- **Shadows.** `cloudShadowMap.ts` is a 512² top-down map of 8 km around the camera. Every texel is
  a ground point marched 12 steps toward the sun through the layer, stored as transmittance. `SkyStage`
  wraps the sun's own `shadow.filterNode` and multiplies it by that map at `positionWorld`, so every
  receiver of the sun darkens under a cloud and no material changes. A scene without a custom filter
  gets a console warning and no cloud shadows. Seen in the lab from 38 m up with a 6 km/min wind:
  the plinth goes fully shaded, then a shadow edge crosses it and the column shadows come back.
- **Environment.** `SkyEnvironment` traces the clouds once more into a 512×256 equirect at 24 steps
  (`CloudLayer.traceDirection`, shared with the screen layer) and composites them over the sky in the
  panorama. The panorama is recaptured when the sun moves, when any cloud setting changes, and every
  4 s while clouds are on, because of the wind. At coverage 0.97 the lab loses its hard sun shadows
  and the mirror sphere reflects the deck.
- The atlas and the probes still follow only through "bake light from this sky".
- Under overcast the plinth reads very dark. It may be the same unverified shade-fill deficit
  listed below.

## Aerial perspective (step 3 of 3)

`aerialPerspective.ts` builds a camera-aligned volume (32×32 columns, 16 linear slices to 32 km) every
frame. Each texel holds the in-scattered light and the mean transmittance from the camera to the end
of that slice. It uses the same medium, phases, planet shadow and multi-scattering LUT as the sky.
`FrameGraph.setAerialPerspective` applies it to opaque pixels before the local fog, using the linear
view depth. `?aerial=0`, `?aerialScale=` and the Sky folder's "aerial distance scale" stretch scene
metres into atmosphere distance, because at scale 1 a 20 m diorama has no visible air (physically
right). Catalog chip "воздушная перспектива ×400".

- **A TSL `select` over the composite's beauty node blacks out the sky.** The divide-and-conquer
  record for this is session 1520ae9e. A pass-through apply rendered correctly. The full apply
  returned without its sky mask also rendered correctly. `select(cond, beauty, beauty)` alone
  turned the sky black, and the auto exposure then washed the geometry white, which first looked
  like a distance bug. The sky is now masked with `mix(beauty, hazed, step(depth, far))`.
- **Samples below the planet surface lost the sun.** A near-horizontal ray kilometres out passes
  under the ground sphere. The planet-shadow test there cut the direct light, and a hard line ran
  along the horizon across every object. Samples are lifted to 0.5 m above the surface.

## Cloud streaks to the vanishing point (2026-09-17)

The user saw clouds lined up in straight rows that converged on the vanishing point, in the mustang
worktree's `?scene=car`. The lab reproduces it with the camera looking down the -z axis. It survives
`historyWeight: 0` (`shots/streaks/axis-nohistory.png`), and a 5 km shape scale makes it strongest
(`shots/streaks/axis-shape5.png`), so it is the tiling volumes and not a reprojection smear.
Identical clouds repeat every period along the axis the camera looks down. `cloudDensity` now reads
the shape and the weather map twice each, on lattices turned by unrelated angles (37/-52 and
23/-67 degrees), with the second lattice scaled by the golden ratio. The weather also warps the
horizontal position by up to ±1.5 km before the shape is read. The same views show no rows
afterwards (`shots/streaks/fixed2-shape5.png`, `fixed2-coverage06.png`). The cost is two more
volume reads per density sample.

## Open

- Aerial perspective on geometry: there is no froxel volume yet. The existing volumetric fog is
  local and ambient-lit.
- Sun movement re-captures the environment (throttled to 0.25 degrees). The frozen bake does not
  follow; "re-bake now" is still the tool.
- The planet ground below the horizon is a flat albedo. A scene with terrain covers it.
- Spectral integration: the LUTs are RGB.
- Only the lab opts in; the beach, forest and village still use the panorama.
- Not verified: shadow fill in the shade 2-10x below the panorama's own sky irradiance, and backlit
  clouds that read flat at low sun (the critic's suspicion is the octave weights plus the two-stream
  term). Both still need an ablation.
