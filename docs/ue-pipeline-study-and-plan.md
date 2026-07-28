# UE5 Pipeline Study → Elderwood Frame Graph v3

**Status:** authoritative. Supersedes `render-pipeline-breakdown.md` and `lumen-static-dynamic-pipeline.md`
(both kept as history; both were written before the UE study below).

**Question this doc answers:** how to build a real render pipeline with a proper
**static / dynamic split for shadows and for light**, and a correct **composing order**.

---

# PART 1 — What Unreal actually does

## 1.1 Frame graph (UE5 deferred, in execution order)

| # | Pass | Reads | Writes | Static/dynamic |
|---|---|---|---|---|
| 0 | InitViews | HZB(n-1), bounds | visibility, light grid | CPU cull; HZB occlusion from last frame |
| 1 | Nanite VisBuffer | cluster data | visibility buffer | — (no web equivalent) |
| 2 | **PrePass** (Z-prepass) | opaque geo | depth (reverse-Z) | all |
| 3 | **HZB** mips | depth | min-mip chain | feeds occlusion + all screen traces |
| 4 | **ShadowDepths** | casters | shadow atlases / VSM pages | **split — see 1.2** |
| 5 | **BasePass** | materials, **lightmaps**, decals | GBuffer A–E | **static lighting is applied here** |
| 6 | Velocity | prev transforms | RG16F motion | dynamic only |
| 7 | **Lumen Scene update** | mesh cards, lights | Surface Cache atlas | **amortized — see 1.3** |
| 8 | **Lumen Final Gather** | HZB, scene color, Lumen Scene | diffuse indirect | screen traces per-frame, cache amortized |
| 9 | Lights / ShadowProjection | GBuffer, shadow maps | scene color (HDR) | per frame, per light |
| 10 | Reflections | HZB, Lumen Scene, captures | scene color | Lumen Refl / SSR / captures |
| 11 | Translucency lighting volume | lights | 2 cascades of 3D grid | per frame |
| 12 | **Volumetric Fog** froxels | lights + shadows | low-res 3D scatter/extinction | temporal reproject |
| 13 | Sky atmosphere / aerial perspective | LUTs | scene color | LUTs cached |
| 14 | Translucency / forward | fog, shadows | scene color | per frame |
| 15 | **TSR** (mid-chain) | color, depth, velocity | upscaled color | temporal |
| 16 | Post: motion blur → bloom → exposure → tonemap+grade → grain | | LDR | per frame |

GBuffer layout (UE4/5 deferred): `A` world normal, `B` metallic/specular/roughness/shadingModelID,
`C` base color + AO, `D` custom data (per shading model), `E` **precomputed shadow factors**
(the 4 stationary-light shadow channels). Note that `E` exists *purely* to carry baked shadowing
into the dynamic lighting pass — that is the static/dynamic seam made explicit in the GBuffer.

## 1.2 Shadows — the static/dynamic split

UE splits shadow **geometry**, not shadow **math**.

### Legacy path (still shipping): cached whole-scene shadow maps
- `r.Shadow.CacheWholeSceneShadows` — for **Movable** point/spot lights.
- Casters with **Static/Stationary** mobility are rendered into a shadow depth **once** and cached.
- Each frame the cached map is copied (`CopyCachedShadowMap` in a RenderDoc capture) and only
  **Movable** casters are re-rendered on top.
- Anything with World Position Offset / animated tessellation / PDO is **excluded from caching**.

### UE5 path: Virtual Shadow Maps
- Virtual resolution **16384×16384** per shadow, tiled into **128×128 pages**; pages are allocated
  only where the depth buffer proves they're needed, and **cached between frames**.
- Directional light = **clipmap**, default levels **6…22**, i.e. from **64 cm** to **~40 km**,
  each level its own 16k VSM covering 2× the previous radius.
- Spot = single 16k VSM + mip chain. Point = cube of six 16k VSMs.
- **VSM keeps two physical copies of depth — a static layer and a dynamic layer.** The static
  layer is cached; the dynamic layer is re-rendered each frame and **composited on top**.
  That's the entire trick: cheap dynamic geometry never invalidates expensive static geometry.
- Classification is **runtime, not mobility**: a Static mesh caches as static; a Movable mesh that
  isn't actually updating gets **migrated into the static cache**.
- **Invalidation sources** (this is the real design constraint):
  - light moves or **rotates** → **all** pages for that light die,
  - a caster moves / spawns / despawns → pages overlapping its bbox die,
  - **WPO / PDO / skeletal animation → invalidates every frame, always**,
  - per-primitive override `ShadowCacheInvalidationBehavior = Auto | Always | Rigid | Static`
    (`Rigid` = ignore WPO, `Static` = also ignore transform changes).
  - Health metric Epic states outright: **invalidated static pages should be ≈ 0**.
- Soft shadows = **SMRT**: ~8 rays × 4–8 samples per ray, spread by **Source Angle** (directional)
  or **Source Radius** (local). Penumbra grows with occluder distance — this is what makes UE
  shadows read as "film" rather than "shadow map".
- **Coarse pages** are force-marked at low detail so volumetric fog and forward translucency can
  sample shadows at arbitrary positions (they have no depth buffer to drive allocation).

**Takeaway:** the shadow split is *caching of caster geometry into two depth layers, merged with
`min()`*. Everything else (filtering, cascades) is orthogonal.

## 1.3 Light — the static/dynamic split

UE splits light along **mobility**, and it splits **direct** from **indirect** independently.

| Mobility | Direct light | Direct shadow | Indirect (GI) | Runtime changeable |
|---|---|---|---|---|
| **Static** | baked into lightmap | baked into lightmap | baked into lightmap | no |
| **Stationary** | **dynamic, deferred** | **baked** for static geo (distance-field shadow map, ≤4 overlapping lights per texel) + **per-object dynamic** shadows for movable objects | **baked** into lightmap | color/intensity yes |
| **Movable** | dynamic | dynamic (CSM / VSM / cached whole-scene) | Lumen / none | fully |

Two receivers, two storage formats:
- **Static geometry** reads baked GI from a **lightmap** (UV2 texture).
- **Dynamic geometry** reads baked GI from the **Volumetric Lightmap**: a sparse adaptive brick
  grid, **4×4×4 cells per brick**, each cell holding **third-order SH irradiance**, denser near
  static surfaces, sparse in empty air, sampled **per pixel** on the GPU.
  This is how a moving character in a baked cave still receives the cave's bounce.

**Stationary is the important one** — it is exactly "свет разделён на статику и динамику":
indirect baked, direct dynamic, static shadowing baked, dynamic shadowing per-object.

### Lumen = the same doctrine, fully dynamic
- **Lumen Scene / Surface Cache**: meshes get **Mesh Cards** (default ~12 per mesh, generated
  offline) captured into an atlas of albedo/normal/depth/emissive.
- Card **direct lighting** and **radiosity** (multi-bounce) are updated for **a fraction of the
  cache per frame** — `r.LumenScene.DirectLighting.UpdateFactor`,
  `r.LumenScene.Radiosity.UpdateFactor`, `r.LumenScene.DirectLighting.MaxLightsPerTile`.
  Epic's own wording: *"updates are amortized over multiple frames"*.
- **Global Distance Field caches movable and static objects separately** — and Epic warns:
  moving an actor marked static invalidates the static cache and *"can be very expensive"*.
  (Same law as VSM, different data structure.)
- Per-frame, per-pixel work is the **Final Gather**: **Screen Traces first** (march the HZB against
  last frame's scene color), fall back to SDF/HW-RT into Lumen Scene, gathered by adaptively-placed
  **Screen Space Probes** (octahedral, importance-sampled by BRDF + last frame's lighting), with a
  **World-Space Radiance Cache** for the far field under an explicit probe trace budget
  (`...RadianceCache.NumProbesToTraceBudget`), then spatial + temporal filter.
- Consequence Epic documents: local lighting changes propagate fast; **global** changes (killing
  the sun) take *multiple seconds* to converge. Amortization is visible, and shipped anyway.

## 1.4 The three laws worth stealing

1. **Split by cost of rebuild, not by "is it a rock".** VSM decides static/dynamic *at runtime* by
   whether a thing actually changed.
2. **Sample every frame, rebuild on a budget.** Every UE cache (VSM pages, surface cache, radiosity,
   radiance cache, global SDF) has an explicit per-frame update fraction, and converges over time
   instead of spiking.
3. **One light state feeds everything.** The same sun drives CSM/VSM, base pass, Lumen card lighting,
   fog froxels, sky LUTs and aerial perspective. Nothing invents its own sun.

---

# PART 2 — What we have

- **Runtime is WebGPU.** `npm run dev` → `vendor/webgiya`, `three/webgpu` `WebGPURenderer` + TSL
  (`vendor/webgiya/src/renderer.ts:14`). Three r182.
- What it actually is: a **surfel-GI research demo** — Cornell Box / Sponza, compute passes
  (`surfelPrepare/Age/FindMissing/Allocate/Integrate/Resolve`), a scene-wide BVH built once at load
  (`sceneBvh.ts`), composite = `fxaa(direct + indirect*albedo)`.
- What it is **not**: a pipeline. No pass ordering, no shadow caching, no mobility system, no
  atmosphere, no fog, no AO, no tonemap chain, one hardcoded directional light, background = raw EXR.
- `src/` is dead (`src/app/main.ts` is a stub that prints an error).

Available in three r182 that we should not re-write: `GTAONode`, `SSGINode`, `SSRNode`, `TRAANode`,
`DenoiseNode`, `BloomNode`, `DepthOfFieldNode`, `Lut3DNode`, `SMAANode`, `TiledLightsNode`,
`CSMShadowNode`, `TileShadowNode`, and — critically — **`ShadowBaseNode` is subclassable**:
`TileShadowNode` proves we can own our own shadow render targets, own cameras, drive
`shadow.camera.layers.mask`, and decide *when* to re-render (`updateShadow(frame)`).
That is precisely the hook a cached static/dynamic shadow needs.

---

# PART 3 — Elderwood Frame Graph v3 (the plan)

## 3.-1 Locked decisions

1. **Root:** harvest webgiya's WGSL BVH + compute plumbing; rebuild `src/` from scratch under FSD.
   webgiya stays vendored under a separate script for A/B only.
2. **Gate scene:** a **corner scene** (Cornell-style corner + ground + one moving object).
   No caves, no forest, until the graph is proven. Old forest/cave content is deleted, not ported.
3. **Sun:** architecture must support **full runtime time-of-day** from day one — but TOD content is
   not built yet. Consequence, and it is a big one:
   - the irradiance volume **cannot be a one-time offline bake**. It must be a
     **continuously refreshing, amortized world radiance cache** (Lumen-shaped), with `sunVersion`
     driving progressive re-integration and a cross-fade between SH sets.
   - the static shadow cache must survive a *moving* sun: quantize the sun, invalidate on step,
     rebuild at most one cascade per frame, never spike.
   - therefore: **no lightmap UV bake path.** Everything static is a *cache*, not a *bake*.
     A cache has a rebuild budget; a bake does not.

## 3.0 Foundational decision: mobility is a first-class concept

Nothing below works without this. Before any shader:

```ts
// shared/world/mobility.ts
export const enum Mobility { Static, Stationary, Movable }

export const LAYER = {
  DEFAULT:        0,
  STATIC_CASTER:  1,   // terrain, rock, trunks, architecture
  DYNAMIC_CASTER: 2,   // player, props, wind foliage, VFX
  GI_STATIC:      3,   // what the baker ray-traces against
} as const;
```

Every entity registers `{ mobility, castShadow, contributesToStaticGI }` and is assigned to layers.
A single `WorldState` holds monotonically increasing dirty counters:

```ts
staticGeoVersion   // ++ when static geometry added/removed/edited
sunVersion         // ++ when sun direction moves beyond quantization step
```

Every cache stores the version it was built at. That is the whole invalidation system, and it is a
direct copy of UE's model — including its most important property: **a camera move invalidates
nothing.**

## 3.1 Shadows: `CachedCascadeShadowNode extends ShadowBaseNode`

Our VSM-equivalent, minus virtual paging (we don't need 40 km).

```
4 cascades, texture arrays:
  staticDepth[4]    ← rendered from LAYER.STATIC_CASTER   — conditionally
  dynamicDepth[4]   ← rendered from LAYER.DYNAMIC_CASTER  — every frame
  sample: occlusion = max( test(staticDepth), test(dynamicDepth) )
```

- **Cascade origins snapped to the shadow-texel grid** → camera translation does not shimmer and
  does not dirty the static layer. (Non-negotiable; without snapping the cache is useless.)
- Static layer re-renders only when `staticGeoVersion` changed, or `sunVersion` changed, or the
  snapped cascade origin moved a whole texel. **Amortized: at most one cascade per frame.**
- Sun is quantized (e.g. 0.25°) so a slow time-of-day doesn't rebuild every frame; between steps
  the near cascade (cheap) may rebuild unconditionally while far cascades morph.
- Dynamic layer contains ~1–2% of the triangles → it is nearly free.
- **Wind foliage is a WPO caster ⇒ it lives in the dynamic layer, permanently.** Same rule UE has.
- Filtering: **SMRT-lite** — N rays × M samples driven by `sun.angularRadius` (real sun ≈ 0.53°),
  so penumbra widens with occluder distance. This single feature is most of the "Unreal look" in
  shadows. Start N=4/M=4, scale by quality tier.
- Debug HUD: `staticRebuilds/sec` must sit at 0 while flying the camera. That is our version of
  Epic's "invalidated static pages ≈ 0".

## 3.2 Light: three tiers, mapped 1:1 to UE mobility

### Tier S — Static (cached, not baked)
An **amortized world radiance cache** over `LAYER.GI_STATIC`, integrated by ray-tracing the
**BVH harvested from webgiya** (`three-mesh-bvh` WGSL traversal). Because the sun must be able to
move (locked decision 3), this is a *cache with a refresh budget*, never a one-shot bake.

- **Irradiance Volume** — our Volumetric Lightmap analogue. Brick grid (clipmap around the camera),
  **L2 SH** per cell, denser near static surfaces. Sampled **per pixel** by *every* receiver —
  static and dynamic alike. Double-buffered SH so a sun step cross-fades instead of popping.
- **Sky visibility / bent normal** per static vertex — computed by the same tracer, refreshed on the
  same budget; sun-independent, so it survives TOD unchanged and is effectively free at runtime.

Budget law: `staticCacheUpdateBudgetMs ≤ 1.5 ms/frame`, N bricks per frame, never the whole volume.
Refresh priority: bricks near camera first, then by staleness. On a sun step: mark all dirty,
re-integrate across many frames, cross-fade old→new. Convergence over seconds is acceptable —
Epic ships exactly that.

### Tier T — Stationary (our sun; the default)
- **direct** = dynamic every frame: CSM above + PBR. Must be dynamic — it has to react to movers.
- **indirect** = Tier-S irradiance volume + screen traces.
- **sun color/intensity** = driven from the atmosphere LUT, changeable at runtime for free.

### Tier M — Movable (torches, fire, player lamp)
- direct: clustered via `TiledLightsNode`.
- indirect: injected into a small low-res dynamic probe shell around the camera, hard-capped.
  Never into the static volume.

## 3.3 GI compose

```
indirect = screenTrace                       // SSGI half-res + temporal — near field, dynamic
         + sampleIrradianceVolume(P, N)      // far field, static, O(1) — NOT rebuilt here
         + dynamicProbes                     // movable lights, capped
indirect *= aoMultiBounce(GTAO bent normal)

hdr = direct + indirect * albedo + volumetric + emissive
```

`sampleIrradianceVolume` **never** triggers a rebuild. Rebuild is a separate budgeted job.

## 3.4 Composing order (the pass graph)

```
0   WorldContext update: sun, wind, time, prevViewProj, dirty versions
1   Depth prepass (opaque)  →  HZB mip chain
2   Shadows:  static cache (conditional, ≤1 cascade/frame) + dynamic (always) → combined
3   Opaque base pass → MRT:
       RT0 HDR color   RT1 normal+roughness   RT2 albedo+matID   RT3 velocity   + depth
4   GTAO half-res + bent normal, temporal
5   GI: screen traces (half-res) + irradiance volume sample → GI buffer → temporal filter
6   Compose: direct + indirect*albedo*ao
7   Sky + aerial perspective (LUT, sun-linked)
8   Volumetric fog froxels (low-res 3D, jittered, temporally reprojected, samples the shadow cascade)
9   Forward pass: foliage alpha, water, particles — reads fog + shadows
10  TRAA  (requires correct velocity from wind-animated foliage)
11  Bloom → exposure → AgX tonemap → LUT grade → grain + vignette
12  Present sRGB
```

Steps 7–8 are where the "Unreal distance look" lives, and 8 is what the concept image
(`concepts/final_output.png`) cannot exist without.

## 3.5 Budget (High tier, 16.6 ms)

| Bucket | ms | Note |
|---|---|---|
| Depth prepass + HZB | 0.5 | |
| Shadows — dynamic layer | 0.6 | ~1–2% of tris |
| Shadows — static rebuild | **≤1.0** | hard cap, ≤1 cascade/frame, usually **0** |
| Base pass MRT | 3.0–4.5 | foliage overdraw is the real enemy |
| GTAO | 0.8 | half-res |
| Screen traces | 1.0–1.5 | half-res |
| Irradiance volume **sample** | 0.3 | |
| Irradiance volume **bake** | **≤1.5** | hard cap; skip → keep last |
| Volumetric fog | 1.0–2.0 | quality tier |
| Forward / translucent | 1.0–2.0 | |
| TRAA + post | 1.5 | |
| Headroom | rest | |

Rule inherited from Lumen: if a cache update would blow its cap, **skip it**. Quality converges
over frames; frame time never spikes.

## 3.6 What happens to webgiya

webgiya is a Cornell-box-scale research demo: whole-scene BVH built at load, per-frame surfel
integrate, no LOD, no alpha, no atmosphere. It will not scale to an open forest, and it is the
wrong thing to grow a pipeline out of. But three parts of it are genuinely valuable:

1. **WGSL BVH traversal** (`src/external/three-mesh-bvh/src/webgpu/`) → becomes our **offline /
   amortized baker** for the irradiance volume. Rays belong in cache builds, not in the frame.
2. **GBuffer + compute plumbing patterns** (`gbuffer.ts`, dispatch-args passes).
3. **The pool / age / budget discipline** — this is exactly the amortized-update model we need.

Proposal: **stop making webgiya the app root.** Rebuild `src/` as the real app under the FSD layout
CLAUDE.md already mandates, harvest the three items above, keep webgiya vendored and runnable under
a separate script for A/B comparison.

## 3.7 Phases, each with a screenshot gate

Gate scene for phases 0–5 is the **corner scene**: two coloured walls + floor + a couple of blocks
+ **one moving object** + a sun that can be scrubbed. Small enough to iterate in seconds, and it
exposes every property we care about (bounce colour, contact shadow, cache invalidation, TOD).

| Phase | Deliverable | Gate (Prime Law) |
|---|---|---|
| **0** Foundation | WorldContext, Mobility+layers, frame-graph skeleton, MRT, corner scene | Inspector shows all MRT targets; no console errors |
| **1** Shadow split | `CachedCascadeShadowNode`: static cache + dynamic layer + SMRT soft | HUD `staticRebuilds/sec == 0` while flying the camera; the moving object's shadow still updates; penumbra widens with occluder distance; scrubbing the sun does not spike frame time |
| **2** Static GI cache | Irradiance volume (SH bricks) via BVH tracer, amortized + double-buffered | Corner shows coloured bounce off the walls; moving object picks up that bounce; sun scrub converges without popping |
| **3** Dynamic near-field GI | SSGI half-res + temporal + compose | Contact bounce under the moving object, tightening the corner |
| **4** Atmosphere + volumetrics | Sky LUT, aerial perspective, froxel fog sampling the shadow cascade | Visible light shafts through the corner opening; fog colour tracks the sun |
| **5** Post chain | AgX, bloom, LUT grade, grain, TRAA | Stable image under camera motion; no over-bloom, no crushed blacks |
| **6** Content | Terrain / trees / grass authored **into** the graph with correct mobility tags | Vista ≥45 fps @1600×900 |

---

## Sources

- [Virtual Shadow Maps in Unreal Engine](https://dev.epicgames.com/documentation/en-us/unreal-engine/virtual-shadow-maps-in-unreal-engine)
- [Shadowing in Unreal Engine](https://dev.epicgames.com/documentation/en-us/unreal-engine/shadowing-in-unreal-engine)
- [Stationary Light Mobility](https://dev.epicgames.com/documentation/en-us/unreal-engine/stationary-light-mobility-in-unreal-engine)
- [Movable Lights (shadow map caching)](https://dev.epicgames.com/documentation/en-us/unreal-engine/movable-lights?application_version=4.27)
- [Volumetric Lightmaps](https://dev.epicgames.com/documentation/en-us/unreal-engine/volumetric-lightmaps-in-unreal-engine)
- [Lumen Technical Details](https://dev.epicgames.com/documentation/unreal-engine/lumen-technical-details-in-unreal-engine)
- [Lumen Performance Guide](https://dev.epicgames.com/documentation/en-us/unreal-engine/lumen-performance-guide-for-unreal-engine)
- [Lumen GI and Reflections](https://dev.epicgames.com/documentation/en-us/unreal-engine/lumen-global-illumination-and-reflections-in-unreal-engine)
- [Volumetric Fog](https://dev.epicgames.com/documentation/en-us/unreal-engine/volumetric-fog-in-unreal-engine)
- [How Unreal Renders a Frame — Interplay of Light](https://interplayoflight.wordpress.com/2017/10/25/how-unreal-renders-a-frame/)
- [Unreal's Rendering Passes — Unreal Art Optimization](https://unrealartoptimization.github.io/book/profiling/passes/)
- [Temporal Super Resolution](https://dev.epicgames.com/documentation/en-us/unreal-engine/temporal-super-resolution-in-unreal-engine)
- [EShadowCacheInvalidationBehavior](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/EShadowCacheInvalidationBehavior)
