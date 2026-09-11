# The artistic look layer, and the sun the panorama search never found

Work of 2026-09-11, implementing [public/lighting-look-development.html](../public/lighting-look-development.html)
(R2, §02 sun bug, §05 artist controls, §06 implementation contract, §09 acceptance).
Checks: `npx tsx scripts/sun-direction-fixture.ts` (CPU) and `node scripts/check-look.mjs`
(headed Chrome; `LOOK_SCENE`/`LOOK_CAM` pick the scene).

## What landed

**Sun direction from the panorama is decoded before it is measured.**
`findSunPositionWeighted` read `texture.image.data` as radiance. For a `HalfFloatType`
panorama that array holds float16 *bit patterns*: 1.0 is 15360 and 100.0 is 22080, so a
half-of-maximum cutoff of 11040 keeps the entire background, the centroid slides to the
middle of the image, and a sun at 67.5° elevation is reported at 0.91°. The search now
lives in `src/shared/gi/surfel/envSunSearch.ts` and decodes through
`THREE.DataUtils.fromHalfFloat` when the texture says half — the same decoder
`sunIntensityFromEnvironment()` already used a few lines away.

Two more corrections came with it, both from §02:

- Bright texels are averaged **as directions on the sphere**, weighted by luminance and
  by the texel's solid angle (`cos(elevation)`). Averaging in UV puts a sun that straddles
  the u=0/1 seam at u=0.5 — the opposite side of the sky. The fixture's seam case reports
  180.00°, not 0°.
- A panorama with no dominant lobe returns `null` — "sun not found" — instead of a
  direction built from numerical residue. The test is the resultant length of the weighted
  mean direction: 1 is one tight lobe, 0 is light spread evenly, and below 0.5 there is no
  sun to point at. Both callers keep the authored angles in that case.

Measured by the fixture on the document's own 8×4 synthetic panorama: float32 and half now
agree to 0.01° (az 112.50, el 67.50); before, half gave el 0.91°.

**The look layer itself** is `src/shared/render/look.ts` plus
`src/shared/render/outputStage.ts`, wired through `FrameGraph.setLook()` and the `Look`
folder in the GUI. It has exactly two application points, as §06 demands:

- *Read-side diffuse indirect gain* (`indirectEV`, `indirectChroma`), applied to the
  sampled irradiance **before** albedo, in all three readers: `applyLightmap`,
  `applyProbeGrid`, and the live-surfel term in the composite. Two module-level uniforms
  carry it, deliberately separate from the transport intensities (`atlasIntensity`,
  probe intensity) that the integrator and the baker read — a slider must never end up in
  the next atlas.
- *Global grade* after AA: exposure compensation on top of the metered exposure, creative
  balance in RGB stops, a luminance curve pivoted at 0.18 with a shadow lift weighted by
  `1 − smoothstep(0.02, 0.18, Y)`, then saturation at constant luminance. The output
  transform (`neutral` / `agx` / `linear`) is the renderer's tone mapper.

Because the grade sits after the meter and the indirect gain sits before it, the two do
not behave alike under auto exposure. That is the documented asymmetry, not a defect.

## Three traps this cost a run each

**The HUD is part of the screenshot.** The first acceptance run said the neutral look
differed from no look by 226/255. The frames were identical; the HUD read `fps 0` in one
and `fps 70` in the other. `page.locator('canvas').screenshot()` does not help — Playwright
captures the page region, lil-gui panel included. `?hud=0` is the fix.

**Exposure was eating the alpha channel.** `resolved.mul(exposureNode)` is a vec4 multiply,
so the frame's alpha came out at 0.5 with a manual exposure of 0.5, the canvas composited
over the page background, and the +1 EV step measured **1.932** instead of 2. Scaling rgb
only puts it at **2.001**. This was a pre-existing pipeline defect, found only because the
document asks for an exact ×2.

**An ablation must not move two things.** `?look=0` first also forced the tone mapper back
to Neutral, so the A/B compared two different pipelines. The output transform now stays
with the renderer whichever way the grade is switched, and disabling the look drives the
indirect uniforms to neutral as well — otherwise "look off" still carried the indirect gain.

## What the acceptance run measures

Corridor, `?hud=0&still=1&aa=none&grain=0&exposure=0.5&lookOutput=linear`, 1280×720:

| Check | Result |
|---|---|
| frame-to-frame noise floor (two identical frames) | 7/255 |
| neutral look vs no look | 6/255, inside the noise floor |
| +1 EV exposure compensation, linear output | ratio 2.001 over 2.76 M samples |
| +1 EV diffuse indirect, `split=baked` | ratio 1.973 |
| first artistic probe (+0.5 EV, +0.35 EV, sat 1.06, contrast 1.04) | 1.834× brighter |
| new console errors while sweeping the sliders | none |

The 7/255 noise floor is the honest limit of this comparison: with `aa=none` the traced
reflections and the probe update still jitter between frames, so "neutral is identity" is
verified to that floor and not to the 1e-4 relative figure §09 asks for. A version of this
check on a still scene without reflections would tighten it.

## Not done

- **Bake provenance and the stale flag** (§08): changing the sun or the environment does
  not yet mark the baked indirect as stale, and nothing shows `provenance unknown` for a
  bake loaded without metadata.
- **Lighting settings read before `staticLight.prepare()`** (§04, the `guiSettings` trap):
  still unfixed, so a first fresh bake can use different env/quality values than the ones
  the panel shows afterwards.
- **The beach did not boot** during this work: `padLightmapCharts` throws
  `chart 13713 has no measured texels` from another session's in-flight edits to
  `staticLight.ts` / `beachScene.ts`. The look layer was therefore accepted on the
  corridor. Nothing here touches the chart padding.
- **Frame cost is not measured.** §09 wants baseline / neutral look / working look at 4K
  with p50/p95/p99. The look adds ALU in the existing composite and no new pass, but that
  is an argument, not a measurement.
- Water and foliage controls (§05's last rows) are untouched.
