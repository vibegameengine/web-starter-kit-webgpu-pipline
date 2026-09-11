# The artistic look layer, and the sun the panorama search never found

Work of 2026-09-11, implementing [public/lighting-look-development.html](../public/lighting-look-development.html)
(R2, §02 sun bug, §05 artist controls, §06 implementation contract, §09 acceptance).
Checks, all headed except the two CPU fixtures: `npx tsx scripts/sun-direction-fixture.ts`,
`npx tsx scripts/sun-direction-real-hdr.ts`, `node scripts/check-look.mjs` and
`node scripts/look-isolation.mjs` (`LOOK_SCENE`/`LOOK_CAM` pick the scene; both default to the
village diorama that the document's own A/B images show).

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

**And on the panorama this project actually ships, the bug moves the sun by 0.03°.**
`pizzo_pernice_puresky_2k.hdr`, 2048×1024, HalfFloat: reading raw bit patterns gives
azimuth 36.22 / elevation 53.11, decoding gives 36.25 / 53.13. Half-float bit patterns rise
monotonically with the value they encode, so on a sky whose sun is a broad bright lobe the
centroid barely moves; the synthetic case breaks only because a single 100× pixel sits on a
uniform background. This answers §02's open question in the direction the document
suspected but could not test: **the HDR bug is real and worth fixing, and it is not why
this frame is dark.** Anyone about to compensate a "wrong sun" with a global lift should
read this line first.

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

## The document's own scene, measured (§03, §04)

`node scripts/look-isolation.mjs`, village diorama, `?cam=front&hud=0&still=1&grain=0`,
1280×720, median scene-linear luminance per region (the grey studio backdrop is listed on
purpose, as the thing that must be excluded from an artistic judgement):

| step | sunlit facade | shadowed facade | terrace stone | water | foliage | backdrop |
|---|---|---|---|---|---|---|
| as shipped (auto exposure, glare on) | 0.0832 | 0.0243 | 0.0769 | 0.0974 | 0.0389 | 0.2110 |
| glare off | 0.0831 | 0.0206 | 0.0759 | 0.0953 | 0.0369 | 0.2113 |
| locked exposure E₀ = 0.5383 | 0.0840 | 0.0210 | 0.0772 | 0.0960 | 0.0371 | 0.2121 |
| E₀ +0.5 stop | 0.1252 | 0.0299 | 0.1200 | 0.1525 | 0.0533 | 0.3180 |
| E₀ +1 stop | 0.1882 | 0.0446 | 0.1884 | 0.2319 | 0.0784 | 0.4680 |
| E₀ + diffuse indirect +0.35 EV | 0.0935 | 0.0226 | 0.0782 | 0.0964 | 0.0403 | 0.2121 |
| first artistic probe | 0.1402 | 0.0347 | 0.1269 | 0.1528 | 0.0592 | 0.3272 |
| probe with the scene glare back on | 0.1405 | 0.0412 | 0.1297 | 0.1554 | 0.0635 | 0.3236 |
| restored profile, neutral look | 0.0824 | 0.0246 | 0.0787 | 0.0973 | 0.0393 | 0.2110 |

What it says:

- **The studio backdrop is 2.5× brighter than the sunlit facades** (0.211 against 0.083)
  and it fills most of the frame. The histogram meter has no subject mask, so the village
  is metered against its own background — §03's suspicion, now with numbers.
- **Locking the settled meter reproduces the shipped frame** (0.0840 against 0.0832, under
  1%), which is what makes the rest of the ladder a diagnosis rather than a new picture.
  Restoring the profile at the end lands back on 0.0824.
- **Veiling glare is a shadow lift, not a highlight bloom here**: turning it off drops the
  shadowed facade by 15% (0.0243 → 0.0206) and leaves the sunlit facade untouched
  (0.0832 → 0.0831). That is exactly the local-contrast loss §03 describes.
- **The diffuse indirect gain is not a brightness slider.** +0.35 EV at a locked exposure
  raises the sunlit facade 11% and the foliage 9%, and moves the water by 0.4% and the
  terrace by 0.1% — the water has its own pass and the terrace reads mostly direct light.
- **The exposure ladder does not double in the displayed frame**: +1 stop measures ×2.24
  here because these medians are read after the Neutral tone mapper. The exact ×2 lives
  directly after exposure, which is what `check-look.mjs` measures with `lookOutput=linear`
  (2.001). Reading a stop off the final PNG is the §04 mistake.
- Against the shipped frame the first artistic probe lifts the sunlit facades 69% and the
  shadows 43% while the backdrop rises 55% — the subject gains on the background, but not
  by much. Separating the two needs the subject mask or a darker backdrop, not a bigger
  gain.

Shots: `shots/look/isolation/00-baseline.png` … `06-restored.png`.

**Trap:** `__fog.exposure()` read straight after boot returns a meter that is still
adapting — 0.8469 on the first run against 0.5383 settled, and locking the early value made
the "baseline" 1.68× brighter than the frame it was supposed to reproduce. The script now
polls until two readings agree within 0.2% before it calls anything E₀.

## The route, in motion (§09)

`node scripts/check-look-route.mjs`, village, animation running, the camera's own exposure
profile left alone, 420 frames around the five poses, then a hard cut to the opposite side:

- the meter adapts along the route without a jump: largest step 1.0% per 150 ms, E drifting
  0.634 → 0.616 (neutral) and 0.610 → 0.595 (working look);
- after the cut it climbs 0.615 → 2.650 over eight samples and settles (last step 0.7%);
- no page errors in either case;
- mid-route, with the meter free to fight back, the working look still leaves the frame
  1.49x brighter in mean luminance than neutral.

Shots in `shots/look/route/`.

## Cine camera presets (asked for on the day, not from the document)

`src/features/render-pipeline/cineCamera.ts` carries six real bodies and lenses with their
published sensor sizes: ARRI ALEXA 35 (27.99 x 19.22) with a 32 mm Master Prime, ALEXA LF
(36.70 x 25.54) with a 40 mm Signature, Sony VENICE 2 (35.9 x 24.0) at 24 mm and 172.8°,
RED V-RAPTOR 8K VV (40.96 x 21.60) at 50 mm, an ALEXA Mini LF with a 2x Cooke anamorphic,
and the IMAX MSM 9802 65 mm gate at 50 mm. A preset sets `camera.filmGauge` to the sensor
width and calls `setFocalLength`, so the horizontal field is the sensor's and the vertical
follows the window - which is what shooting a wider aspect on that sensor does. The 2x
squeeze is the gauge doubled, which is exactly the horizontal field an anamorphic sees, and
needs no projection-matrix surgery. The shutter angle goes to the motion blur (180° = 0.5,
VENICE's 172.8° = 0.48).

The photometric difference between presets is **reported, never applied**: ISO and T-stop
against a reference of ISO 800 / T2.8 / 180° give the ALEXA 35 at T1.3 a +2.21 EV
difference, the IMAX at ISO 500 −0.68 EV. A preset does not take the exposure away from the
camera's own meter; a button in the GUI puts that stop difference into the Look if the
person wants it. `?cine=<name>`, GUI folder Cine camera, hook `__cine(name, focalMm)`, and
three chips on the village card.

`node scripts/check-cine-cameras.mjs` switches all six in one page and checks each
projection against `2·atan(sensor·squeeze / 2f)`: 47.24° for the ALEXA 35 at 32 mm, 73.59°
for the VENICE at 24 mm, 76.76° for the anamorphic, 70.30° for IMAX against 44.55° for
vista vision at the same 50 mm. One assertion in the first run was wrong and the code was
right - the anamorphic is wider than IMAX because its lens is 40 mm, not 50.

## Bake provenance, and the settings the bake never saw (§08, §04)

**The bake now carries the light it was baked under.** `lightingProvenance.ts` records the
sun's direction, intensity and colour, a digest of the environment panorama's texels, a
digest of the transport settings and a lighting revision; it rides in the manifest the dev
server already writes beside the bake, so no lightmap byte and no bake format changed. The
comparison only reports, with reasons in words - "the sun moved 6.00°", "sun intensity
4.657 → 6.985" - on the HUD as `baked light`, in the GI bake folder beside "re-bake now",
and through `__audit.bakeStatus()`. Nothing in code rebakes, deletes or rewrites because of
it, and a bake saved before provenance existed says `provenance unknown` instead of
claiming to be valid.

The environment's identity is a digest of every 64th texel rather than its URL, because two
scenes can name the same path while the file on disk has been replaced.

`node scripts/check-bake-stale.mjs`: a fresh corridor bake reports valid and is saved with
its provenance; moving the sun 10° turns it stale with that reason; raising the intensity
adds a second reason; the bake file's mtime does not change through any of it; putting the
sun back reports valid again; the HUD row reads it; and the village's older bake reports
unknown.

**The saved lighting profile now reaches the atlas.** §04's guiSettings trap was real: the
lighting controls are created after `staticLight.prepare()`, and a saved profile is applied
to controls that exist - so the first fresh bake ran with the code defaults while the panel
afterwards showed the saved numbers. `lightingSettings.ts` reads lightmap passes, atlas mul,
probe mul and env out of the profile before the bake; `staticLight.bakedWith` records what
the bake actually ran with, inside `bakeAtlas`.

`node scripts/check-lighting-settings-order.mjs` writes a scene profile with 160 passes and
atlas mul 0.7, drops that scene's bake, and reads `bakedWith` back:
`{"passes":160,"rays":32,"atlasIntensity":0.7,"atlasSize":512}`, with the panel showing the
same two numbers. A first attempt used 23 passes and the bake refused to persist as
unconverged - which is its own proof that the number reached the baker.

## Not done

- **Water and foliage controls** (§05's last rows, the document's own P4) are untouched.
- **The beach does not boot** at the moment: `padLightmapCharts` throws
  `chart 13713 has no measured texels`, from another session's in-flight work on
  `beachScene.ts`. Nothing here touches the chart padding. The village and the corridor
  both boot, and the village is the scene the document's A/B images show.
- **Frame cost is not measured.** §09 wants baseline / neutral look / working look at 4K
  with p50/p95/p99. The look adds ALU in the existing composite and no new pass, but that
  is an argument, not a measurement. The user stopped this one on 2026-09-11: four agents
  were driving their own browsers on this machine, so a millisecond measured here would be
  theirs as much as ours. `scripts/check-look-route.mjs` therefore reports no frame times
  at all - it walks the route and asks only what the light does.
- Water and foliage controls (§05's last rows) are untouched.
