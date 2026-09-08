# CLAUDE.md — Elderwood AAA Forest Showcase

## Current user direction (2026-09-07, overrides historical sections below)

- Develop **jure/webgiya** and the existing local surfel GI. The active runtime is `src/app/main.ts`, Three r182 **WebGPU**, TSL/WGSL, Neutral tone mapping and FXAA. Do not replace it with path tracing or add a path-tracing reference application.
- Priority: virtual textures/lightmaps, streaming, correct layering/filtering; separately, a cheap high-quality dynamic-lighting model sharing one world with baked statics.
- **Short useful iterations are the main rule. Every step adds working functionality or fixes a visible defect. No measurements for their own sake.** Test only questions that guide the current change and inspect fresh headed frames.
- Source of current scope: [render-quality-goal.md](docs/render-quality-goal.md). Other references are raw examples, not ground truth.
- Default lighting is `hybrid`: bake the full static UV atlas once at startup, keep static illumination frozen, and run live surfels for unbaked receivers. Camera movement must never trigger static re-baking. `surfel` is an explicit experimental mode; freezing its camera-seeded cache can preserve coverage holes.
- Live coverage uses the same visibility-weighted gather as shading. Pinned atlas samples may seed lighting but must not satisfy live coverage or crowd live samples out. Baked receiver ownership is encoded in GI normal alpha. `scripts/check-dynamic-coverage.mjs` checks moving receivers; `GI_CONTINUOUS=1` also exercises continuous animation. Zero coverage holes does not prove smooth or temporally stable GI.
- Rigid movable meshes keep local surface anchors for live surfels (`surfelMotion.ts`). GI normal alpha is 1 for baked receivers, 0 for unbound receivers, and a negative rigid receiver id otherwise. Move anchors before integration, clear world visibility after movement, and query the previous grid at the receiver's previous position. Skinned/instanced/vertex-deformed receivers still use the unbound path. `scripts/check-rigid-surfels.mjs` verifies actual GPU positions and retained surface identity; `RIGID_SURFELS=0` is its world-space control.
- Hybrid loads a project-local bake manifest, a resident fallback, and compressed lightmap pages on demand over HTTP. Default `bakedHits` transport reads those same pages at static BVH hits using barycentric lightmap UV. Authoring texel surfels are released after saving; the restored path does not request their four arrays. Runtime uses a shared 4096-slot live pool independent of atlas resolution; `?bakedHits=0` retains the former parent-cache path for comparison. Compute sampling has explicit array layer/LOD, parent fallback and the same page fade as raster. `bakedHitLod.ts` now projects a pixel cone through the hit triangle's world-to-atlas Jacobian; the largest ellipse axis selects trilinear LOD. Cone propagation is a flat-bounce sampling heuristic, not a BRDF/curvature differential. Broad chart filtering, anisotropy and dynamic indirect correction on baked surfaces remain outstanding.
- Existing GI hits now request pages through `bakedPageFeedback.ts`: one bounded asynchronous 64 KiB snapshot at most every 150 ms, no new rays or integrator storage binding. In baked mode the previously unused `SurfelMoments.hit` diagnostic stores UV / packed floor(LOD)*16+importance / frame; authoring keeps the original diagnostic format. Requests start at the sampled mip, include coarser parents and never fetch finer unused pages. GI and camera share the same physical slots/request/upload limits, with a small GI admission allowance, score smoothing and stale-request expiry. `?giPageFeedback=0` disables this producer. `scripts/check-gi-page-feedback.mjs --lod` checks real hit-driven requests, producer ablation, fallback, motion, LOD overrides and resize; `--rebake` adds the explicit rebake lifetime check. `check-baked-lod-math.mjs` runs the production footprint WGSL on analytical cases.
- Re-baking the same virtual layout uses `VirtualLightmap.replaceSource`, retaining the material-bound GPU texture objects while cancelling old requests and replacing data. Replacing and disposing the physical array caused black raster regions after rebake despite healthy dynamic GI; the rebake check now compares static HDR shading as well. Keep this lifetime invariant when changing the publishing path.
- Lightmap chart rectangles are aligned to `2 ** safeMip` through the resident fallback. UVs stay inside that mip's first/last texel centres; base guard pixels isolate the baker's 3x3 denoiser too. `chartPadding.ts` extends only measured samples within their own rectangle, preserving measured black. The blit retains coverage alpha; the main bake disables global GPU dilation and no longer calls brightness-based `dilateUnlitTexels`. Once padded, ordinary box mip generation is safe through `safeMip` without runtime chart metadata or a persistence format change. This does not fix overlapping projected UVs or provide anisotropic filtering. `node scripts/check-chart-filter.mjs` exercises actual UV rasterisation and the production GPU sampler at chart edges through mip 2, including black charts and no resident pages.
- `SurfelGI.syncDynamicScene(renderer, scene, { materialsChanged? })` synchronises a batch of runtime rigid additions/removals and geometry/material replacements. It replaces the dynamic BVH/bindings and material array when necessary, retaining static geometry/BVH/UVs, baked pages and the shared live pool. Receiver slots survive neighbour removal and freed slots are reused; geometry replacement retires only the affected anchors. Membership changes invalidate live visibility of the old scene while retaining surviving irradiance. Old dynamic GPU buffers and material render targets are disposed. Call explicitly after scene edits, not every frame; ordinary motion uses `updateDynamicScene()`. `check-runtime-movers.mjs` exercises spawn, removal, slot reuse, motion, empty scene and respawn with GPU owner/coverage checks. This is still rigid geometry, with at most 1024 receiver slots; deformation support remains open. `check-baked-transport.mjs` covers streaming/bake reuse across launches. Do not present a small pool or zero holes as proof of final dynamic-lighting quality.
- Dynamic intersection now uses `dynamicHierarchy.ts`: immutable object-space BLASes shared by geometry/material template, plus a world-space TLAS refitted after pose changes. Five padded vec3 records per instance hold its BLAS root and affine inverse in the existing attribute storage buffer. Only changed records and the TLAS prefix are uploaded; local vertices, indices and BLAS nodes remain unchanged. Rays retain world-distance parameterisation under nonuniform scale/shear; normals use inverse transpose. The integrator still has 14 storage bindings. `check-dynamic-hierarchy.mjs` compares actual GPU intersections against Raycaster and observes queue writes; it also covers padded static material-ID remapping. Membership changes still rebuild the bundle, and long movement can degrade a refitted TLAS topology. Passing intersection tests does not establish temporal GI stability; the cross-receiver eviction defect is fixed in iteration 17 below.
- Rigid anchor transport now uploads only changed receiver records. A stopped receiver settles its previous matrix once; subsequent stationary frames upload no pose data and skip the anchor-move compute pass. Initialisation, activation and pool replacement still force transport. `check-rigid-motion-work.mjs` observes actual GPU queue writes and compares current/previous positions and transported normals; its byte counts cover the anchor transform buffer only, not the whole GI frame. Lighting integration remains live; cross-receiver eviction is addressed in iteration 17 below. Optional `GI_STEPS`, `GI_SETTLE_FRAMES` and `GI_DEBUG` in `check-runtime-movers.mjs` help reproduce that defect without adding production readbacks.
- `receiverOwnership.ts` adds baked/rigid owner metadata to Three's material observer. Prepare materials at initial scene build and membership sync; do not force all materials to refresh each frame or recompile when an owner changes. `check-receiver-owner.mjs` covers stationary shared-material meshes, late installation, and rigid/baked/unbound transitions. `GI_REINSERT=1` in the full mover check returns the same Mesh under a new slot after its previous slot was occupied; `GI_EXPIRE_OWNER=7` forces the real economy to retire that receiver's samples and checks recovery after eight frames. The stale-owner bug is reproduced and fixed; iteration 17 fixes the separate cross-receiver eviction mechanism.
- Iteration 15 adds bounded raster anisotropy to virtual lightmaps, superseding the outstanding-anisotropy notes above. `filterFootprint.ts` derives singular axes from screen UV derivatives; the minor width selects LOD and up to eight line taps cover the major axis. Each tap uses the same page resolver, fallback and fade as compute, clamped to a per-vertex `lightmapBounds` attribute. GI hit-cone sampling remains isotropic. Texture allocation and page budgets are unchanged; chart bounds add 16 bytes per vertex. CPU demand uses perspective-correct derivatives at triangle centroids, an approximation rather than exact pixel feedback. `check-anisotropic-lightmap.mjs` checks frequency preservation, filtering, page/chart boundaries, fallback and matching demand on the GPU. Coarsest-mip limits, temporal tap-count transitions and general UV unwrap support remain open; this is not full EWA or a demonstrated FPS improvement.
- Hybrid live integration now uses `integrationSchedule.ts`, a GPU histogram/admission queue with a default 4096 primary GI samples/frame shared by all receivers. Fresh histories, changed positions/normals and inconsistent estimates gain priority; waiting age raises priority, and stable receivers request work every fourth GI update. Skipped probes copy all five moment vectors across the ping-pong buffers. Admission uses the output moments' temporary `hit.w`, restored by integration, preserving 14 integrator storage bindings. Four scheduling passes and 48 bytes/slot + 768 bytes are additional costs; the ray cap is not a GPU-millisecond or total-ray guarantee. Bake is unscheduled. `check-integration-schedule.mjs` and `check-runtime-ray-budget.mjs` verify actual GPU admission/history. Audit `stepGI` now advances NodeFrame as well as renderer.info.frame so PassNode beauty is current. Cross-receiver eviction is corrected in iteration 17; `GI_RAY_BUDGET=0` disables admission for a runtime-mover control, and `GI_DEBUG_LATE=1` enables pixel diagnostics only after a hole appears.
- Iteration 17 fixes cross-receiver crowding in the live economy. Hybrid rent now counts only unpinned samples with the same valid receiver owner and compatible normal (dot > 0.8), using the pre-economy grid membership. Do not reject age >= TTL inside that loop: neighbours retire concurrently. Counting unrelated receivers could kill a covered patch after FindMissing, causing black faces and repeated respawning. `check-receiver-economy.mjs` reproduces the old eviction of 128 unrelated receivers, verifies their survival and opposite-face isolation, and retains eviction of actual same-surface duplicates. The pool and ray budget remain shared. Audit-only recheck/replay separates a repeated FindMissing dispatch from changed uniforms or recompilation; no extra production dispatch was added. Broader dynamic-lighting quality and indirect correction of statics remain unfinished.
- Beach foliage materials come from leaf biology, not hand colours. `foliage/leafOptics.ts` is a PROSPECT plate model (pigments → R/T spectra → linear sRGB); `leafMaterial.ts` is a thin-leaf BSDF with shadowed Lambert + Henyey–Greenstein transmission inside the lighting model, cuticle GGX with F0 from n=1.42, and vein tint from the same optics; `leafSurface.ts` builds venation relief/gloss maps in leaf space. `palm/trunkSurface.ts` generates the coconut stem surface (spiral leaf scars, growth-rate internodes, fissures, weathering, lichen) from one height field into albedo/normal/roughness/cavity covering the trunk once. Vertex attributes `color` and `transmittance` carry R and T. `npx tsx scripts/leaf-optics-fixture.ts` checks the optics; camera presets `?cam=trunk|trunkLit|shrub|shrubBack|palm|leaves` show the materials. Leaves also carry `LeafEnvironmentNode` (knee-compressed sky, specular radiance and back-face transmission only; the scene has no `scene.environment`), and the beach host sets `sunIntensity: 'environment'` so the analytic sun carries the energy the GI knee clips from the panorama (`sunFromEnvironment.ts`, `?sun=` overrides); `check-leaf-lighting.mjs` measures leaf response to the sun. The screen-space GI composite does not transmit through leaves, and the beach bake key changes every launch (pre-existing, unresolved).
- **Never run anything headless.** User rule (2026-09-08): every capture, check and measurement uses a headed Chrome window; `capture-chrome.mjs` and all `check-*.mjs` launch headed unconditionally. Headless is not an option to mention or offer.
- Iteration 21 adds two toggleable light-spreading stages, both driven by scene presets (`SceneHost.atmosphere`, `SceneHost.glare`; the beach sets them, Cornell does not). `shared/render/atmosphere/volumetricFog.ts` is froxel fog (160x90x64 `Storage3DTexture`, exponential slices, Halton jitter + reprojected history 0.9): density from height falloff x soft box x animated Perlin, sun through the real shadow map with the same matrix/compare as `receiverPlaneShadow.ts`, sky as clamped mean environment radiance, analytic per-slice integration, applied in the composite after the overlay at min(scene, overlay) depth via `FrameGraph.setAtmosphere`. `FrameGraph.setGlare` is zero-threshold low-strength bloom (veiling glare) after the fog. URL: `?fog=0|1 fogDensity fogSun fogSky fogNoise fogView=inscatter|transmittance`, `?glare=0|1 glareStrength glareRadius`; GUI folders Atmosphere and Post; audit hook `window.__fog`. `scripts/check-atmosphere.mjs` proves on/off toggling reproduces `?fog=0`, no new console errors versus the fog-off boot, no black frame after a camera move, and reports GPU ms on/off. Not done: sky/aerial LUT (no sky in the diorama), multiple scattering, GI-lit fog, local lights in fog, PCSS soft penumbrae, TAA. The `THREE.TSL: Invalid generated code, expected a "vec3"` console error on the beach reproduces with `?fog=0` and comes from concurrent beach material work, not from these stages.
- Iteration 22: `shared/render/softSunShadow.ts` is the default sun filter — PCSS on top of `receiverPlaneShadow.ts` with the sun's 0.533° disc (`U_SUN_ANGULAR_DIAMETER_DEG`, `?sunDisc=`): 16-tap blocker search in the receiver's sun cone, penumbra radius = blocker distance x tan(alpha) / 2 per texel (clamped 16), exact 4x4 receiver-plane box below 1.5 texels, otherwise 32 blue-noise-rotated bilinear Poisson taps with a per-tap plane correction bounded at 70 deg/texel. `?shadowFilter=receiverPlane|legacy` are the ablations; do not remove the hard filter, it is the soft one's core. `check-shadow-receivers.mjs` still passes clean with it; `check-soft-shadows.mjs` measures the 10-90% edge width soft vs hard at `?cam=shore`. Open: no cascades, 16-texel cap, residual grain in wide penumbrae without TAA, GI still traces a point sun.
- Iteration 23: `shared/render/temporalAA.ts` (`TemporalAANode`) is the default anti-aliasing; `?aa=taa|fxaa|none`, GUI Post. Plumbing follows three's TRAANode (read, not imported); the resolve is ours: YCoCg variance clipping, Catmull-Rom history, Karis weights, closest-depth velocity dilation. The Halton jitter is applied by `FrameGraph.beginFrame()` at the top of the frame, before `gi.update` and the fog, and cleared by `endFrame()` after render: every screen-space consumer must see the same jittered projection, and `velocity` keeps the unjittered one. Rule from the user: take working pieces from three by copying them into our code, re-reading and improving them, never by importing an addon we cannot change. `check-taa.mjs` measures stair steps against none/fxaa, camera-cut history rejection, flat-sand drift and GPU ms. Open: no depth-history disocclusion, no sharpening, fixed 0.9 history.
- Iteration 24: contact occlusion by short BVH rays (`shared/gi/contact/`): `boundedTrace.ts` bounded any-hit over static + movers, `contactOcclusionPass.ts` compute kernel from the GI G-buffer (depth-derived geometric normal, 2 cosine rays x 0.5 m per frame, reprojected depth-tested history, octahedral bent normal), `contactBvh.ts` a full-detail second static tree because the GI tree's cluster proxy boxes put contact rays inside boxes (open sand read 0.45 with it, 1.0 without). Applied to indirect only: live surfel term multiplied, lightmap term subtracted through the `bakedIndirect` fragment property carried in G-buffer channels `normal.a` + `velocity.ba` (do not reuse those channels). On by default at a half grid with one ray: +1.1 ms per frame (`scripts/_gpu_frame_probe.mjs`, timestamps resolved every frame). A reader object that changed identity per call once rebuilt the composite every frame and ate memory in seconds: anything handed to `FrameGraph.set*` must be identity-stable; measure GPU cost only with per-frame timestamp resolves, never with a 40 ms poll. `?contact=0 contactScale= contactRays= contactRadius=`, grid scale is boot-time only, split views `contact` / `bentNormal`, GUI Contact occlusion, hooks `__fog.contact()` / `__fog.split(view, at)` / `__fog.contactSettings`, `?still=1` freezes scene animation for checks. Never `this.tap()` inside `rebuildComposite` (taps accumulate across rebuilds). `check-contact.mjs` (with contact=1) proves clean open sand, darker boulder feet, darkening confined to occluded pixels. Open: specular/sky occlusion from the bent cone, foliage traced in rest pose.
- The older WebGL baseline, 45-fps target, phase order, nonexistent technique-bible link, delegation/model suggestions and “not a git repo” statement below are historical and do not govern current work.
- Ordinary directional sunlight now uses `receiverPlaneShadow.ts`: 16 raw depth loads, per-texel receiver-plane comparison, translated 3x3 PCF weights. It removes reproduced camera-dependent shadow acne on the wall/sphere without enlarging the 4096 shadow map or bias. `?shadowFilter=legacy` is the ablation; point/cascade/array shadows are not covered. `check-shadow-receivers.mjs` checks wall/shadow contrast in two camera poses and captures sphere closeups. **Open visual defect:** restored-cache closeups can show large hard-edged GI patches on the sphere, also with shadowContribution=0 and the legacy filter, persisting after 200 GI steps. This is distinct from the fine shadow-acne stripes; do not report the whole sphere as visually accepted. Evidence: `shots/shadow-receivers/final-sphere-unshadowed.png`, `legacy-sphere-unshadowed.png`, `settled-sphere.png`.
- Secondary-bounce `lookupSurfelGI` samples up to 32 entries stratified across the entire hash-cell list, with a phase from the existing independent light-sampling noise. Never restore a first-32 prefix: dense atlas probes from several surfaces share cells, and prefix selection loses whole surfaces near corners, baking dark seams. Small cells still visit every entry once. Same lookup cap, rays, buffers and passes; no runtime rebake. `scripts/check-corner-lightmap.mjs` captures both corners, detail/fallback and overview, verifies frozen pixels, and supports `GI_PREFIX_CONTROL=1 GI_QUERY=&bakeCache=0` to reproduce the old gather in the browser without changing production files.

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
