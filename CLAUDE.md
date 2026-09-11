# CLAUDE.md — Elderwood AAA Forest Showcase

## Current user direction (2026-09-07, overrides historical sections below)

- Develop **jure/webgiya** and the existing local surfel GI. The active runtime is `src/app/main.ts`, Three r182 **WebGPU**, TSL/WGSL, Neutral tone mapping and FXAA. Do not replace it with path tracing or add a path-tracing reference application.
- Priority: virtual textures/lightmaps, streaming, correct layering/filtering; separately, a cheap high-quality dynamic-lighting model sharing one world with baked statics.
- **Short useful iterations are the main rule. Every step adds working functionality or fixes a visible defect. No measurements for their own sake.** Test only questions that guide the current change and inspect fresh headed frames.
- Source of current scope: [render-quality-goal.md](docs/render-quality-goal.md). Other references are raw examples, not ground truth.
- One pipeline, no modes. The static half is a UV lightmap atlas baked once at startup and then frozen; the dynamic half is live surfels; the frame adds them. `surfel`, `lightmap` and `hybrid` were three separately wired modes and were removed 2026-09-09 (commit 99ebd2f) along with their dropdown, their URL parameter `?mode=` and their cache keys. Camera movement must never trigger static re-baking. A scene declares `staticLighting: true` only when it has no movers at all; the beach does not, and freezing its live half turned every shaded frond into a black silhouette, because the foliage has no chart in the atlas and no other source of indirect light. `?freezeAll=0|1` overrides the scene.
- Live coverage uses the same visibility-weighted gather as shading. Pinned atlas samples may seed lighting but must not satisfy live coverage or crowd live samples out. Baked receiver ownership is encoded in GI normal alpha. `scripts/check-dynamic-coverage.mjs` checks moving receivers; `GI_CONTINUOUS=1` also exercises continuous animation. Zero coverage holes does not prove smooth or temporally stable GI.
- Rigid movable meshes keep local surface anchors for live surfels (`surfelMotion.ts`). GI normal alpha is 1 for baked receivers, 0 for unbound receivers, and a negative rigid receiver id otherwise. Move anchors before integration, clear world visibility after movement, and query the previous grid at the receiver's previous position. Skinned/instanced/vertex-deformed receivers still use the unbound path. `scripts/check-rigid-surfels.mjs` verifies actual GPU positions and retained surface identity; `RIGID_SURFELS=0` is its world-space control.
- The bake is one resident 512-square atlas, saved to `public/bakes/<key>.bin` and read back on the next launch (`?bakeCache=0` forces a re-bake). The key is sha256 of the scene name, so one scene owns exactly one bake; `npm run bake:clear -- --stale default,beach` drops every other key. Virtual pages, HTTP page transport, the indirection table, the LRU and the CPU page-demand pass were removed 2026-09-08 (code in commit 34de65e); the design for bringing them back, and the reasons not to yet, are in [virtual-pages-design.md](docs/virtual-pages-design.md). A bounce ray landing on charted static geometry now reads the atlas directly - three `textureLoad` of the baked UV, sentinel check, barycentric, one sample - and everything the unwrap refused keeps the surfel cache. `?atlasHits=0` is the control; `scripts/_atlas_read_mutation.mjs` proves the branch runs by replacing its sample on the wire, because a zero A/B is also what a dead branch produces.
- Live coverage, receiver ownership, the shared live pool and the ray-budget admission queue are unchanged by that removal. `bakedPageFeedback.ts`, `bakedHitLod.ts`, `VirtualLightmap.replaceSource`, `filterFootprint.ts` and the per-vertex `lightmapBounds` attribute are gone with the pages, and with them raster anisotropy and ray-cone LOD on the atlas. Both are open, not solved.
- Lightmap charts still need their guard pixels: `chartPadding.ts` extends only measured samples inside each chart's own mip-aligned rectangle, preserving measured black, and the blit keeps coverage alpha. `node scripts/check-chart-filter.mjs` exercises real UV rasterisation and the production sampler at chart edges. Overlapping projected UVs are still unsolved.
- Lightmap chart rectangles are aligned to `2 ** safeMip` through the resident fallback. UVs stay inside that mip's first/last texel centres; base guard pixels isolate the baker's 3x3 denoiser too. `chartPadding.ts` extends only measured samples within their own rectangle, preserving measured black. The blit retains coverage alpha; the main bake disables global GPU dilation and no longer calls brightness-based `dilateUnlitTexels`. Once padded, ordinary box mip generation is safe through `safeMip` without runtime chart metadata or a persistence format change. This does not fix overlapping projected UVs or provide anisotropic filtering. `node scripts/check-chart-filter.mjs` exercises actual UV rasterisation and the production GPU sampler at chart edges through mip 2, including black charts and no resident pages.
- `SurfelGI.syncDynamicScene(renderer, scene, { materialsChanged? })` synchronises a batch of runtime rigid additions/removals and geometry/material replacements. It replaces the dynamic BVH/bindings and material array when necessary, retaining static geometry/BVH/UVs, the resident atlas and the shared live pool. Receiver slots survive neighbour removal and freed slots are reused; geometry replacement retires only the affected anchors. Membership changes invalidate live visibility of the old scene while retaining surviving irradiance. Old dynamic GPU buffers and material render targets are disposed. Call explicitly after scene edits, not every frame; ordinary motion uses `updateDynamicScene()`. `check-runtime-movers.mjs` exercises spawn, removal, slot reuse, motion, empty scene and respawn with GPU owner/coverage checks. This is still rigid geometry, with at most 1024 receiver slots; deformation support remains open. `check-bake-persistence.mjs` covers bake reuse across launches. Do not present a small pool or zero holes as proof of final dynamic-lighting quality.
- Dynamic intersection now uses `dynamicHierarchy.ts`: immutable object-space BLASes shared by geometry/material template, plus a world-space TLAS refitted after pose changes. Five padded vec3 records per instance hold its BLAS root and affine inverse in the existing attribute storage buffer. Only changed records and the TLAS prefix are uploaded; local vertices, indices and BLAS nodes remain unchanged. Rays retain world-distance parameterisation under nonuniform scale/shear; normals use inverse transpose. The integrator still has 14 storage bindings. `check-dynamic-hierarchy.mjs` compares actual GPU intersections against Raycaster and observes queue writes; it also covers padded static material-ID remapping. Membership changes still rebuild the bundle, and long movement can degrade a refitted TLAS topology. Passing intersection tests does not establish temporal GI stability; the cross-receiver eviction defect is fixed in iteration 17 below.
- Rigid anchor transport now uploads only changed receiver records. A stopped receiver settles its previous matrix once; subsequent stationary frames upload no pose data and skip the anchor-move compute pass. Initialisation, activation and pool replacement still force transport. `check-rigid-motion-work.mjs` observes actual GPU queue writes and compares current/previous positions and transported normals; its byte counts cover the anchor transform buffer only, not the whole GI frame. Lighting integration remains live; cross-receiver eviction is addressed in iteration 17 below. Optional `GI_STEPS`, `GI_SETTLE_FRAMES` and `GI_DEBUG` in `check-runtime-movers.mjs` help reproduce that defect without adding production readbacks.
- `receiverOwnership.ts` adds baked/rigid owner metadata to Three's material observer. Prepare materials at initial scene build and membership sync; do not force all materials to refresh each frame or recompile when an owner changes. `check-receiver-owner.mjs` covers stationary shared-material meshes, late installation, and rigid/baked/unbound transitions. `GI_REINSERT=1` in the full mover check returns the same Mesh under a new slot after its previous slot was occupied; `GI_EXPIRE_OWNER=7` forces the real economy to retire that receiver's samples and checks recovery after eight frames. The stale-owner bug is reproduced and fixed; iteration 17 fixes the separate cross-receiver eviction mechanism.
- Contact occlusion is off by default (the user judged it noise without visible gain); `?contact=1` turns it on and `check-contact.mjs` passes it explicitly. The full-detail contact BVH is still built at boot regardless, because reflections trace it.
- Hybrid live integration now uses `integrationSchedule.ts`, a GPU histogram/admission queue with a default 4096 primary GI samples/frame shared by all receivers. Fresh histories, changed positions/normals and inconsistent estimates gain priority; waiting age raises priority, and stable receivers request work every fourth GI update. Skipped probes copy all five moment vectors across the ping-pong buffers. Admission uses the output moments' temporary `hit.w`, restored by integration, preserving 14 integrator storage bindings. Four scheduling passes and 48 bytes/slot + 768 bytes are additional costs; the ray cap is not a GPU-millisecond or total-ray guarantee. Bake is unscheduled. `check-integration-schedule.mjs` and `check-runtime-ray-budget.mjs` verify actual GPU admission/history. Audit `stepGI` now advances NodeFrame as well as renderer.info.frame so PassNode beauty is current. Cross-receiver eviction is corrected in iteration 17; `GI_RAY_BUDGET=0` disables admission for a runtime-mover control, and `GI_DEBUG_LATE=1` enables pixel diagnostics only after a hole appears.
- Iteration 17 fixes cross-receiver crowding in the live economy. Hybrid rent now counts only unpinned samples with the same valid receiver owner and compatible normal (dot > 0.8), using the pre-economy grid membership. Do not reject age >= TTL inside that loop: neighbours retire concurrently. Counting unrelated receivers could kill a covered patch after FindMissing, causing black faces and repeated respawning. `check-receiver-economy.mjs` reproduces the old eviction of 128 unrelated receivers, verifies their survival and opposite-face isolation, and retains eviction of actual same-surface duplicates. The pool and ray budget remain shared. Audit-only recheck/replay separates a repeated FindMissing dispatch from changed uniforms or recompilation; no extra production dispatch was added. Broader dynamic-lighting quality and indirect correction of statics remain unfinished.
- Beach foliage materials come from leaf biology, not hand colours. `foliage/leafOptics.ts` is a PROSPECT plate model (pigments → R/T spectra → linear sRGB); `leafMaterial.ts` is a thin-leaf BSDF with shadowed Lambert + Henyey–Greenstein transmission inside the lighting model, cuticle GGX with F0 from n=1.42, and vein tint from the same optics; `leafSurface.ts` builds venation relief/gloss maps in leaf space. `palm/trunkSurface.ts` generates the coconut stem surface (spiral leaf scars, growth-rate internodes, fissures, weathering, lichen) from one height field into albedo/normal/roughness/cavity covering the trunk once. Vertex attributes `color` and `transmittance` carry R and T. `npx tsx scripts/leaf-optics-fixture.ts` checks the optics; camera presets `?cam=trunk|trunkLit|shrub|shrubBack|palm|leaves` show the materials. Leaves also carry `LeafEnvironmentNode` (knee-compressed sky, specular radiance and back-face transmission only; the scene has no `scene.environment`), and the beach host sets `sunIntensity: 'environment'` so the analytic sun carries the energy the GI knee clips from the panorama (`sunFromEnvironment.ts`, `?sun=` overrides); `check-leaf-lighting.mjs` measures leaf response to the sun. `normalMap()` unpacks 0..1 itself: never feed it `·2−1` (a critic found every leaf and trunk normal tilted ~55° by that). The trunk map holds real albedo (a mean-1 gain clipped 86 % of texels to white). PROSPECT R includes the cuticle Fresnel term, so the diffuse albedo is `R − surface`; the mirror sky is clipped at the GI knee (5) and rachis/petiole (transmittance 0) are matte. The leaf mirror fades below the horizon: a puresky panorama's lower half is a synthetic grey, and reflecting it turned every underside steel-blue (the GI under the crown was fine, proven by the `LEAF_ENV_RADIANCE` cut). Contact-occlusion dots on foliage are the contact pass, not the material; the tracer shades foliage hits as a two-faced sheet (reflect on the near face, T·E·cos/π through from the far face, `?giLeafTransmit=0` ablation) — visually equal to the old unflipped-normal leak because R_lum ≈ T_lum for green leaves. The screen-space GI composite does not transmit through leaves, the beach bake key no longer changes every launch: it is sha256 of the scene name (fixed 2026-09-08 with the cache rewrite).
- Six commits on 2026-09-09 removed the lighting modes and the virtual pages. What that series broke, and the rules that came out of it - a commit whose feature was not in it, an A/B that could not fail, four checks that agreed with the damage, and the noise floor of a beach comparison - is in [lessons-dead-features.md](docs/lessons-dead-features.md). Read it before deleting a subsystem.
- **No long timeouts, and never walk away from a broken renderer.** User rule (2026-09-11): a check
  waits seconds, not minutes. Gate every headed script at a few minutes, give each `waitForFunction`
  a bound that matches what it waits for, and handle the error path explicitly - a script that hangs
  thirty minutes on an exception that arrived in the first second is the failure. The same rule
  covers the tree: several agents work in this one repository, so a renderer left in a state where
  the app cannot boot blocks everyone. Before starting any long step, boot the app and look; if a
  change cannot be finished, leave the tree in a state that runs.

- **Never run anything headless.** User rule (2026-09-08): every capture, check and measurement uses a headed Chrome window; `capture-chrome.mjs` and all `check-*.mjs` launch headed unconditionally. Headless is not an option to mention or offer.
- **Never leave the renderer broken, and never wait out a failure.** User rule (2026-09-11): this repository is shared by several sessions at once, so a pipeline error you introduce is everybody's error — check the plain URL boots before starting any long measurement, and fix a break before walking away from it. Harness scripts must fail on the first error instead of sitting on a timeout: watch `#error-overlay` and the page's `pageerror`, and exit the moment either fires. A 240-second `waitForFunction` that ends in a timeout when the answer was known in two seconds is the defect, not the scene.
- **A new view is not delivered as a URL for the user to type.** User rule (2026-09-11): when something new can be looked at — a lab, a split view, a debug pane — wire it into the UI in the same change: a chip on its card in `src/app/home/catalog.ts`, a GUI control, or whatever the user already clicks. Handing over `?lab=1` and waiting to be asked "why don't I see it" is the failure: the user opened the app, found nothing, and had to send a screenshot with an arrow. A URL parameter is the ablation for checks, never the way a person reaches the feature.
- Iteration 21 adds two toggleable light-spreading stages, both driven by scene presets (`SceneHost.atmosphere`, `SceneHost.glare`; the beach sets them, Cornell does not). `shared/render/atmosphere/volumetricFog.ts` is froxel fog (160x90x64 `Storage3DTexture`, exponential slices, Halton jitter + reprojected history 0.9): density from height falloff x soft box x animated Perlin, sun through the real shadow map with the same matrix/compare as `receiverPlaneShadow.ts`, sky as clamped mean environment radiance, analytic per-slice integration, applied in the composite after the overlay at min(scene, overlay) depth via `FrameGraph.setAtmosphere`. `FrameGraph.setGlare` is zero-threshold low-strength bloom (veiling glare) after the fog. URL: `?fog=0|1 fogDensity fogSun fogSky fogNoise fogView=inscatter|transmittance`, `?glare=0|1 glareStrength glareRadius`; GUI folders Atmosphere and Post; audit hook `window.__fog`. `scripts/check-atmosphere.mjs` proves on/off toggling reproduces `?fog=0`, no new console errors versus the fog-off boot, no black frame after a camera move, and reports GPU ms on/off. Not done: sky/aerial LUT (no sky in the diorama), multiple scattering, GI-lit fog, local lights in fog, PCSS soft penumbrae, TAA. The `THREE.TSL: Invalid generated code, expected a "vec3"` console error on the beach reproduces with `?fog=0` and comes from concurrent beach material work, not from these stages.
- Iteration 22: `shared/render/softSunShadow.ts` is the default sun filter — PCSS on top of `receiverPlaneShadow.ts` with the sun's 0.533° disc (`U_SUN_ANGULAR_DIAMETER_DEG`, `?sunDisc=`): 16-tap blocker search in the receiver's sun cone, penumbra radius = blocker distance x tan(alpha) / 2 per texel (clamped 16), exact 4x4 receiver-plane box below 1.5 texels, otherwise 32 blue-noise-rotated bilinear Poisson taps with a per-tap plane correction bounded at 70 deg/texel. `?shadowFilter=receiverPlane|legacy` are the ablations; do not remove the hard filter, it is the soft one's core. `check-shadow-receivers.mjs` still passes clean with it; `check-soft-shadows.mjs` measures the 10-90% edge width soft vs hard at `?cam=shore`. Open: no cascades, 16-texel cap, residual grain in wide penumbrae without TAA, GI still traces a point sun.
- Iteration 23: `shared/render/temporalAA.ts` (`TemporalAANode`) is the default anti-aliasing; `?aa=taa|fxaa|none`, GUI Post. Plumbing follows three's TRAANode (read, not imported); the resolve is ours: YCoCg variance clipping, Catmull-Rom history, Karis weights, closest-depth velocity dilation. The Halton jitter is applied by `FrameGraph.beginFrame()` at the top of the frame, before `gi.update` and the fog, and cleared by `endFrame()` after render: every screen-space consumer must see the same jittered projection, and `velocity` keeps the unjittered one. Rule from the user: take working pieces from three by copying them into our code, re-reading and improving them, never by importing an addon we cannot change. `check-taa.mjs` measures stair steps against none/fxaa, camera-cut history rejection, flat-sand drift and GPU ms. Open: no depth-history disocclusion, no sharpening, fixed 0.9 history.
- Iteration 24: contact occlusion by short BVH rays (`shared/gi/contact/`): `boundedTrace.ts` bounded any-hit over static + movers, `contactOcclusionPass.ts` compute kernel from the GI G-buffer (depth-derived geometric normal, 2 cosine rays x 0.5 m per frame, reprojected depth-tested history, octahedral bent normal), `contactBvh.ts` a full-detail second static tree because the GI tree's cluster proxy boxes put contact rays inside boxes (open sand read 0.45 with it, 1.0 without). Applied to indirect only: live surfel term multiplied, lightmap term subtracted through the `bakedIndirect` fragment property carried in G-buffer channels `normal.a` + `velocity.ba` (do not reuse those channels). Off by default since 2026-09-09 (`?contact=1` turns it on); at a half grid with one ray it costs +1.1 ms per frame (`scripts/_gpu_frame_probe.mjs`, timestamps resolved every frame). A reader object that changed identity per call once rebuilt the composite every frame and ate memory in seconds: anything handed to `FrameGraph.set*` must be identity-stable; measure GPU cost only with per-frame timestamp resolves, never with a 40 ms poll. `?contact=0 contactScale= contactRays= contactRadius=`, grid scale is boot-time only, split views `contact` / `bentNormal`, GUI Contact occlusion, hooks `__fog.contact()` / `__fog.split(view, at)` / `__fog.contactSettings`, `?still=1` freezes scene animation for checks. Never `this.tap()` inside `rebuildComposite` (taps accumulate across rebuilds). `check-contact.mjs` passes `?contact=1` itself and proves clean open sand, darker boulder feet, darkening confined to occluded pixels. Open: specular/sky occlusion from the bent cone, foliage traced in rest pose.
- Iteration 25: traced reflections (`shared/gi/reflect/reflectionPass.ts`), on by default, +2.5 ms: one GGX ray per half-grid cell from the GI G-buffer (its new third attachment `specular` = F0 + roughness), screen trace against the GI depth reading the TAA history colour, then `traceScene` on the contact tree (now carrying `bvh_attribute`) + movers shaded with `giShadeHit`, then the environment; depth-tested history 0.85. Composite: radiance x DFG LUT (F0*A + B) x contact bent-cone occlusion, added on top (materials have no environment specular of their own). `?reflections=0 reflectionsRoughness=`, split view `reflections`, GUI Reflections, hooks `__fog.reflections()` / `reflectionSettings`. `check-reflections.mjs` at `?cam=water`. Open: indirect at the hit is a flat ambient (no surfel lookup in that kernel), no velocity reprojection of the screen colour, no neighbour ray reuse, rough surfaces (> 0.55) get nothing.
- Iteration 26 halves the boot: 35.3 s to 16.2 s to steady frames on the beach (`scripts/check-boot-time.mjs`, headed, median of three, measured from inside the page with `addInitScript` — an evaluate cannot start while the main thread is blocked, which is what a slow boot is). Two causes. The soft sun shadow's 16 + 32 Poisson taps were JS `for` loops, so every tap was written into the WGSL of every material the sun reaches: 3.3 MB of the boot's 4.6 MB of generated shader, single fragments of 157 KiB, `fragment_cliff` as fat as any leaf. They are now `Loop()` over `uniformArray` tables, and `receiverPlaneShadow.ts`'s 4x4 box is one loop with index-derived weights — same taps, same arithmetic, WGSL 4657 to 1468 KiB. Second, generating WGSL (main thread) and compiling it (GPU process) ran strictly in series: 5.7 s then 4.8 s idle. `renderer.compileAsync(scene, camera)` now starts before the contact BVH, which is built eagerly instead of inside the first frame, so the two overlap; `?warmup=0` is the ablation. `check-soft-shadows.mjs` still separates the sun discs and `check-reflections.mjs` is clean. The eager compile prints one Inspector warning about a node outside frame scope (`?inspector=0` silences it); `renderer.inspector` cannot be nulled and swapping in a plain `InspectorBase` breaks the real one. Open, all measured on the dev server: 3.4 s of procedural generation still on the CPU (bark, leaf and rock noise), 2.4 s + 2.2 s of single-threaded SAH BVH builds, and four palms each building their own copy of the `palm-frond` material. Details in [lessons-boot-time.md](docs/lessons-boot-time.md).
- Iteration 27 (2026-09-10) implements [design-cheap-aaa-lighting.md](docs/design-cheap-aaa-lighting.md): `src/features/render-pipeline/` is the default pipeline (`?pipeline=legacy` keeps the old one, which this iteration did not edit); the live surfel chain is off in the frame (`?surfelGi=1` re-enables it as an option) and `src/shared/gi/probes/` holds a DDGI-style probe volume — per probe an 8x8 octahedral irradiance tile and a 16x16 (mean, mean²) distance tile plus relocation offset and active flag — baked at warm-up by seeding 64 direction-surfels per probe into the atlas integrator, with distances and backface classification from a `probeTrace` kernel over the contact tree, relocation, dilation, and Chebyshev visibility + normal/view bias at the sample. Probes ride in the bake file (format v3, block `PROB`). Checks, all headed: `check-probe-constant.mjs`, `check-probe-projection.mjs` (corner 3.5/255 and beach 4.2/255 against the live chain), `check-probe-leak.mjs` (corridor `?moverAt=0,0.8,-1.9`: `?probeVisibility=0` doubles the error, so the branch is alive), `check-probe-persistence.mjs`, `check-probe-budget.mjs` (4K beach: legacy 29.8 ms, new 12.8 ms, 11.0 without reflections). Split view: `?split=baked` shows the atlas+probe term; `gi`/`indirect` panes need `?surfelGi=1`. Later the same day: rough surfaces take their specular from the probes along the reflection direction (`FrameGraph.setProbeRadiance`, `?probeSpecular=0`); the GI G-buffer renders at half resolution when the live chain is off (`?giScale=`, 4K 12.8 to 11.6 ms, water frame unchanged); a material shared by a charted and an uncharted mesh is cloned for the probe term (0 such on the beach); probes store sky and sun terms apart with a runtime `sunScale` (`?probeSunSplit=0`, the sky pass runs with atlas reads off); classification marks probes with no geometry in their voxel `empty`; `?probeLive=1` keeps the direction surfels resident and refreshes them under `?probeRayBudget=` a frame with MSME sample counts cut on a sun change (`check-probe-live.mjs`). Later still: one geometry pass (metalness/roughness in `velocity.ba`, baked-indirect luminance in `normal.a`, the GI G-buffer is not rendered when the live chain is off; contact and reflections read the scene pass), a TAA motion stencil (`?taaStencil=0`, `check-taa-stencil.mjs`) and an à-trous reflection denoiser (`?reflectionsDenoise=0..3`, two passes by default and one on the beach, `check-reflection-denoise.mjs` whose oracle is distance to the converged trace), in [lessons-one-pass-stencil-denoise.md](docs/lessons-one-pass-stencil-denoise.md). Interior/exterior probe layers (`host.interiorVolumes`, bits packed into the probe record's state channel, `?probeLayers=0`, `?probeLayerMask=`, `check-probe-layers.mjs`) are in the same lessons file. Open: probe streaming, and no scene yet shows the layers doing visible work. Details and traps in [lessons-probe-volume.md](docs/lessons-probe-volume.md).
- Iteration 28 (2026-09-11) implements [lighting-look-development.html](public/lighting-look-development.html): `src/shared/render/look.ts` is the artist layer and `outputStage.ts` the place it is applied. Two application points, no new pass. Read-side `artisticIndirect()` (`U_LOOK_INDIRECT_GAIN`, `U_LOOK_INDIRECT_CHROMA`) multiplies sampled irradiance before albedo in all three readers - `applyLightmap`, `applyProbeGrid`, live surfels in the composite - and is deliberately separate from the transport intensities the baker and the integrator read, so a slider never reaches the atlas. The global grade runs after AA: exposure compensation on the metered exposure, creative balance in RGB stops, a 0.18-pivot luminance curve with shadow lift, saturation at constant luminance; the output transform is the renderer's tone mapper. GUI folder `Look`, hooks `__fog.look` / `lookApply` / `lookEnabled` / `lookNeutral`, URL `?look=0 exposureEV indirectEV indirectChroma saturation contrast shadowLiftEV balanceR|G|B lookOutput=neutral|agx|linear`. `findSunPositionWeighted` moved to `src/shared/gi/surfel/envSunSearch.ts`: half-float panoramas are decoded (`DataUtils.fromHalfFloat`) before luminance, bright texels are averaged as directions on the sphere with their solid angle so a sun on the u=0/1 seam no longer lands on the opposite side, and a panorama without a dominant lobe returns null instead of residue - both callers keep the authored angles then. Exposure multiplied the frame's alpha too, which composited the page background into every pixel and made the +1 EV step measure 1.932; rgb-only scaling gives 2.001. Checks: `npx tsx scripts/sun-direction-fixture.ts` and `node scripts/check-look.mjs` (`LOOK_SCENE`/`LOOK_CAM`). Open: bake provenance/stale flag, lighting settings read before `staticLight.prepare()`, frame-cost measurement at 4K, water and foliage controls. Details in [lessons-artistic-look.md](docs/lessons-artistic-look.md).
- The older WebGL baseline, 45-fps target, phase order, nonexistent technique-bible link, delegation/model suggestions and “not a git repo” statement below are historical and do not govern current work.
- Ordinary directional sunlight now uses `receiverPlaneShadow.ts`: 16 raw depth loads, per-texel receiver-plane comparison, translated 3x3 PCF weights. It removes reproduced camera-dependent shadow acne on the wall/sphere without enlarging the 4096 shadow map or bias. `?shadowFilter=legacy` is the ablation; point/cascade/array shadows are not covered. `check-shadow-receivers.mjs` checks wall/shadow contrast in two camera poses and captures sphere closeups. **Open visual defect:** restored-cache closeups can show large hard-edged GI patches on the sphere, also with shadowContribution=0 and the legacy filter, persisting after 200 GI steps. This is distinct from the fine shadow-acne stripes; do not report the whole sphere as visually accepted. Evidence: `shots/shadow-receivers/final-sphere-unshadowed.png`, `legacy-sphere-unshadowed.png`, `settled-sphere.png`.
- Secondary-bounce `lookupSurfelGI` samples up to 32 entries stratified across the entire hash-cell list, with a phase from the existing independent light-sampling noise. Never restore a first-32 prefix: dense atlas probes from several surfaces share cells, and prefix selection loses whole surfaces near corners, baking dark seams. Small cells still visit every entry once. Same lookup cap, rays, buffers and passes; no runtime rebake. `scripts/check-corner-lightmap.mjs` captures both corners, detail/fallback and overview, verifies frozen pixels, and supports `GI_PREFIX_CONTROL=1 GI_QUERY=&bakeCache=0` to reproduce the old gather in the browser without changing production files.

## A day lost to laziness: answering a cheaper question than the one asked (2026-09-10)

The user asked for a switch that turns the surfel GI off, and had been talking about
**frame cost** for the whole conversation. What was built instead was a mask in
`surfelGIResolvePass` that stops the screen resolve from *reading* surfels for one class
of receiver.

This was laziness, and it should be recorded as laziness rather than as a
misunderstanding. The read mask is one line. Stopping the work means following the
chain up into `gi.update` and the frame loop and deciding what may be skipped, which is
an afternoon of reading. The cheap edit was chosen, shipped as if it were the answer,
and then defended. It answers a different question - what the light contributes to the
picture - while the G-buffer render, the spawn pass and the integrator keep running for
every screen pixel regardless of who reads the result.

The frame did not move. The user said so immediately, from their own screen. It was
contradicted three times with measurements instead, each taken at 720p or with the
inspector's timestamps on, where the ablation appeared to save 3.6 ms. The disagreement
lasted until the switch was finally made to skip the work, at which point the beach went
from 33.1 ms to 8.6 ms at 4K - 24.5 ms, against the 0 the user had been reporting all
along.

**Rules that come out of it.**

- An ablation switch must stop the *work*, not its consumer. A mask on a read leaves the
  producer running and answers nothing about cost. If the question is milliseconds, the
  switch has to reach `gi.update`, the pass dispatch, or the loop that issues it.
- When the user reports what their screen does, that is data and it outranks a
  measurement that disagrees with it. Find why the measurement is wrong - resolution,
  camera, instrumentation, saved settings - before answering back with numbers.
- Read the question that was asked, not the one that is cheap to satisfy. "Give me a
  switch to turn X off" in a conversation about frame time means the cost of X.

Two more traps from the same day, both of which cost their own detour:

- A CPU profile taken before the scene has truly settled catches the boot building
  shaders and reports it as a per-frame cost. It produced a confident, wrong claim that a
  quarter of the frame was shader regeneration. Wait for hundreds of steady frames, and
  print the interval you warmed up to.
- `config/gui-settings.json` is applied only when the URL carries nothing but
  `scene`, `cam`, `hud` or `settings`. A plain load therefore uses the file, and any
  ablation parameter silently switches to code defaults. A saved `atlas mul = 0.15` made
  Cornell look black for the user while every parameterised capture looked correct, and
  the user was told their URL was at fault. It was the opposite.

## Comments: forbidden, one exception (2026-09-09, user rule)

**Do not write comments in code. The code is the documentation.** If a line
needs explaining, the explanation belongs in a name: rename the variable, extract
the function, give the magic number a named constant. Facts that are not code —
measurements, sources, verdicts — go in `docs/`.

**The one exception is `@important`.** A comment tagged `@important` is allowed
when, and only when, it records WHY a decision is this one and not the obvious
alternative — a reason that genuinely cannot live in the code. Use it rarely.

**`@important` also carries what the clean-code skill calls the comment that must
stay** — a measurement, a source, a verdict that would be lost otherwise. One tag,
one rule: if it is worth keeping in the source, it is tagged. Everything else goes
to `docs/`.

Two hooks enforce it, and they measure the same thing:

- `.claude/hooks/no-comments-guard.mjs`, `PreToolUse` on `Write|Edit|MultiEdit|NotebookEdit`,
  denies the call before it lands. It compares the comments in the new text
  against the old: identical ones cancel, and what is left cancels against what
  the edit removed — so **rewriting or deleting a comment is allowed, adding one
  on top is not**. Renaming a symbol an existing comment names is therefore a
  legal edit, which is what `.claude/skills/clean-code` demands.
- `.claude/hooks/no-comments-stop.mjs`, on `SessionStart` and `Stop`, compares the
  whole working tree against `HEAD`. This is the one that cannot be walked around
  by writing files through `sed`, a heredoc or a script — and auto mode tells the
  agent to do exactly that. `SessionStart` records the comments the tree already
  carried, because this tree is shared with other sessions; the `Stop` gate fires
  only on what grew after.

Both cover `.ts .tsx .mts .cts .js .jsx .mjs .cjs` under the project root, using
the TypeScript **parser** in `scripts/lib/cleanCode.mjs` — not a bare scanner,
which goes blind after the first `${}` in a file and used to miss 44.8% of this
repository. A `//` inside a GLSL template literal is still not a comment.
`@important` must open the comment, machine directives must be the real thing
(`@ts-expect-error`, `eslint-disable-*`, `prettier-ignore`, `/// <reference>`,
`@license`) — prose that merely starts with the word `eslint` is denied.

**A `//` run is one comment.** Tag its first line and the continuation lines ride
along; a blank line ends the run and the next line needs its own tag. A block
comment `/* @important … */` is one comment however many lines it spans.
Directives are never grouped, or `// eslint-disable-next-line` would carry a
paragraph through. Both hooks share one implementation of this in
`scripts/lib/commentRule.mjs`, so they cannot drift apart.

`node scripts/check-no-comments.mjs` is the check: 25 cases covering both hooks,
including every bypass found by a critique of the first version.

This supersedes the "three fates" comment guidance in `.claude/skills/clean-code`:
the fate "keep it" now means "keep it, tagged `@important`". The length thresholds
in that skill are unchanged.

---

This file is the **constant compass** for building this scene. Read it before every work session.
Goal: a **Skyrim-mood forest landscape** in Three.js + Vite that looks **no worse than Unreal Engine**.

---

## 0. The Prime Law — VERIFY VISUALLY

> **A feature does not exist until it has been seen in a screenshot.**

Every visible change is validated by capturing the running app and *looking* at the pixels.

```bash
npm run dev            # starts Vite on http://127.0.0.1:5188
npm run shot -- out.png --wait 3500   # headless Chromium screenshot after warmup
```

- After any visual edit → capture → open the PNG → judge it against the scorecard (§4).
- Never claim "done / AAA / looks great" without a fresh screenshot in the same turn.
- A blank/black canvas or console error = **FAIL**, fix before moving on.
- Capture wide shots (hero vista) AND close-ups (grass, bark, water edge).

## 1. Build Order (authored forms → materials → lighting → VFX)

Do **not** try to make primitives look AAA by adding glow. Order matters:

1. **Form** — real geometry/silhouette (terrain relief, tree structure, grass blades).
2. **Material** — PBR albedo/roughness/normal, correct color space, tone mapping.
3. **Lighting** — physically-plausible sun + sky IBL, soft shadows, fog depth.
4. **VFX / Post** — bloom, GTAO, DoF, color grade, atmosphere. Polish, never a crutch.

## 2. Architecture — Feature-Sliced Design (FSD)

Layers import strictly downward: `app → widgets → features → entities → shared`.

```
src/
  app/        composition root, bootstrap, GUI wiring
  widgets/    scene assembly (world), HUD
  features/   time-of-day, wind, camera-controls, quality
  entities/   terrain, grass, trees, water, sky, clouds  (each self-contained)
  shared/     lib (engine, noise, math), config, ui helpers
```

Rules:
- An **entity** owns its geometry, material, shaders, and an `update(dt, ctx)` method.
- Cross-entity data (sun dir, time, wind, camera) flows via a single `WorldContext` in `shared`.
- No entity imports another entity. Shared env (sun, wind, fog) is injected.
- One public `index.ts` per slice (public API). Keep shaders in co-located `*.glsl.ts`.

## 3. Technical Baseline

- **Renderer:** WebGL2, `WebGLRenderer` (chosen for reliable headless capture).
  - `outputColorSpace = SRGBColorSpace`, `toneMapping = AgXToneMapping` (filmic), `toneMappingExposure ≈ 1.0`.
  - `shadowMap.enabled`, `PCFSoftShadowMap`. Cascaded/large single shadow for the sun.
- **Post (pmndrs `postprocessing`):** `EffectComposer` → GTAO/SSAO → Bloom (subtle) → DoF (optional) → ToneMapping → SMAA.
- **Color discipline:** albedo textures/colors are sRGB; data (normal/rough/AO) is linear. Never double-correct.
- **Fog:** exponential height/atmosphere fog tuned to sun color for depth. Fog is 50% of the "AAA distance" look.
- **Perf target:** ≥ 45 fps at 1600×900 on a mid GPU. Instancing for grass/trees. LOD + frustum/distance culling.

## 4. Visual Scorecard (each ≥ 2/3 before claiming AAA)

| Category        | 3 = AAA                                                     |
|-----------------|------------------------------------------------------------|
| Art direction   | cohesive Skyrim palette, strong silhouette, mood           |
| Terrain         | believable relief, splat texturing, no visible tiling      |
| Grass/plants    | dense, wind-animated, translucent, grounded (no floating)  |
| Trees           | SpeedTree-ish structure, LODs, wind sway, good canopy      |
| Water           | reflections + refraction + animated waves + shore blend    |
| Sky/clouds      | volumetric or convincing clouds, atmospheric scattering    |
| Lighting        | directional sun + sky IBL, soft shadows, god-ray mood      |
| Post/grade      | filmic tone map, subtle bloom, AO contact shadows          |
| Depth/fog       | aerial perspective, distance haze                          |
| Performance     | smooth, no hitches, stable frame time                      |

**Automatic FAIL:** blank canvas, console errors, floating props, z-fighting, over-bloom, blown highlights.

## 4b. Unreal Technique Bible

Deep, numbers-heavy UE5→Three.js mapping (tonemap, sky/aerial fog, Nubis clouds, fake Lumen,
splat terrain, foliage wind, LOD, water, post chain, sun/shadows) lives in
[`docs/unreal-technique-bible.md`](docs/unreal-technique-bible.md). Consult it before any
material/lighting/shader decision. The core "AAA glue": one sun drives light + fog + sky +
clouds; fog color is an aerial-perspective blend, never grey; AO + subtle bloom + AgX + cool
grade stacked subtly.

## 5. Reference Repos / Techniques (curated)

- Trees: **dgreenheck/ez-tree** (`@dgreenheck/ez-tree`) — procedural SpeedTree-grade trees.
- Water: three.js `Water` (Ocean) example; **achrefelouafi/OceanThreejs** for FFT-grade seas.
- Clouds: raymarched Worley/FBM volumetrics (Maxime Heckel; danielesteban/clouds).
- Grass: GPU-instanced blade shader with wind + subsurface (Simon Dev / Ghost-of-Tsushima approach).
- Terrain: simplex/fbm heightfield + slope/height splat blending (terrains.zyfod.dev = Terrain Studio).
- Sky: three.js `Sky` (Preetham) with sun-linked lighting.

## 6. Workflow Notes

- Heavy module implementation may be delegated to **sonnet** subagents; keep interfaces (`WorldContext`, entity `create/update`) stable so modules compose.
- Reserve **fable** for the hardest single-shot shader/algorithm tasks.
- Commit cadence: not a git repo yet; keep changes coherent and runnable at all times.
- After each entity lands: `npm run shot` → eyeball → tick the scorecard.

## Shared agent work feed

Codex and Claude share `tmp/dashboard/feed.jsonl`. The first feed hook registers
the agent automatically in the dashboard and refreshes live status on each later
tool call. It prints the session key required by `own.mjs` and `ask.mjs`;
`register.mjs` is optional for replacing the automatic label and goal. Post evidence-first updates with
`node scripts/post.mjs --author "<you>" --text "..." --shot <png>`.

Before editing a path, run `node scripts/own.mjs --who <path>` and claim an
unowned area with `own.mjs --session <printed-session> --claim "<path-or-glob>"
--why "<work>"`. Ask a live owner through the visible feed with
`node scripts/ask.mjs --session <printed-session> --to <owner-id> --text "..."`.
Never use `comment.mjs` or write as the human. A `[FOR YOU]` entry must be
acknowledged with `ack.mjs` before the next tool call.

