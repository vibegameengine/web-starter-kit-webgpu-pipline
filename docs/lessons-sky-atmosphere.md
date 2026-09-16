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
- **A `select` does not skip work on the GPU.** Moving the light march behind `If(extinction > 0)`
  and adding `Break` at 1 % transmittance took the lab from 44.8 fps to the 120 fps vsync cap at
  1600x900, with the frame unchanged.
- **A deep deck lit only by octaves reads as a dark blue veil.** The octaves die exponentially,
  which leaves the base lit by the blue sky alone. A two-stream diffuse transmission term,
  1 / (1 + 3/4 tau (1 - g)), weighted in only at large optical depth, turned overcast grey-white and
  greyed the cumulus bases as well.
- **Coverage used directly as the erosion threshold floods the noise.** At 0.85 the threshold fell
  to 0.15 and every billow filled in, leaving no structure. The threshold is now
  1 - 0.75 x coverage, and the default coverage moved from 0.55 to 0.73 to keep the same look.
- A cloud 1.5 km straight overhead is soft at half resolution. Horizon views are not.

## Open

- Aerial perspective on geometry: there is no froxel volume yet. The existing volumetric fog is
  local and ambient-lit.
- Sun movement re-captures the environment (throttled to 0.25 degrees). The frozen bake does not
  follow; "re-bake now" is still the tool.
- The planet ground below the horizon is a flat albedo. A scene with terrain covers it.
- Spectral integration: the LUTs are RGB.
- Only the lab opts in; the beach, forest and village still use the panorama.
- Clouds are not in the environment capture (bake, probes, reflections) and cast no shadows yet (step 2).
- There is no aerial perspective volume; clouds fade to the sky with one 45 km exponential (step 3).
