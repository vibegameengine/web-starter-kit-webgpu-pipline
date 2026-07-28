# Elderwood Render Pipeline — Step-by-Step with Primary Sources

**Purpose:** prove every stage of our Unreal-class pipeline with real papers, Epic docs, SIGGRAPH talks, and working open-source — not vibes.

**Companion:** [`render-pipeline-breakdown.md`](./render-pipeline-breakdown.md)  
**Visual north star:** `concepts/final_output.png`

---

## How to read this

For each step:

1. **What** — what the pass does  
2. **Why (theory)** — physics / graphics reason  
3. **Proof** — papers / talks / engine docs (primary links)  
4. **How engines do it** — Unreal / games  
5. **How we do it on Web** — Three.js WebGPU/TSL path  
6. **Status in Elderwood** — have / partial / missing  

---

# The pipeline (order of truth)

```
0 Prep/WorldContext
1 Cascaded soft shadows
2 Geometry / G-Buffer (MRT)
3 Direct lighting (PBR + sun + IBL)
4 Ambient occlusion
5 Indirect GI (probes / SSGI / surfels)
6 Atmosphere (sky)
7 Height fog / aerial perspective
8 Volumetrics / god rays
9 Specials (foliage, water, particles)
10 Temporal AA / TSR-lite
11 Display post (exposure, bloom, tonemap, grade, grain)
12 Present sRGB
```

---

# Step 0 — Prep / Single World Lighting Context

### What
One shared state every pass reads: sun direction/color, sky tints, time, wind, camera, previous matrices, exposure EV.

### Why
In nature there is one sun. If shadow color, fog color, and sky disagree, the image looks “CG” immediately. Production engines force a single light transport driver.

### Proof
| Source | Link |
|---|---|
| UE: one Directional Light drives atmosphere, fog, volumetrics | [Sky Atmosphere](https://dev.epicgames.com/documentation/unreal-engine/sky-atmosphere-component-in-unreal-engine) |
| UE Volumetric Fog is *part of* Exponential Height Fog, lit by same lights | [Volumetric Fog](https://dev.epicgames.com/documentation/unreal-engine/volumetric-fog-in-unreal-engine) |
| Lumen technical coupling to scene lighting | [Lumen Technical Details](https://dev.epicgames.com/documentation/unreal-engine/lumen-technical-details-in-unreal-engine) |

### How we do it
`WorldContext` (`src/shared/engine/context.ts`) — already designed this way.

### Status
**Partial** — interface exists; not yet the sole driver of Pipeline2.

---

# Step 1 — Cascaded Soft Shadows (CSM + filter)

### What
Split the view frustum into 3–4 depth ranges; each gets its own shadow map (high res near camera, coarse far). Soften with VSM / PCF / PCSS.

### Why
A single 2048² shadow map over a 1 km forest is ~0.5 m/texel at the horizon → staircase shadows. Cascades fix **perspective aliasing**. Soft filters fix hard 1-bit edges.

### Proof — Cascaded Shadow Maps
| Source | Link |
|---|---|
| Microsoft / DirectX tech article (canonical industry write-up) | [Cascaded Shadow Maps (MSDN)](https://learn.microsoft.com/en-us/windows/win32/dxtecharts/cascaded-shadow-maps) |
| NVIDIA PDF: parallel-split CSM for large terrain | [Dimitrov — Cascaded Shadow Maps (NVIDIA)](https://developer.download.nvidia.com/SDK/10.5/opengl/src/cascaded_shadow_maps/doc/cascaded_shadow_maps.pdf) |
| MJP blog — practical comparison of CSM filters | [A Sampling of Shadow Techniques (MJP)](https://therealmjp.github.io/posts/shadow-maps/) |

### Proof — Soft filters
| Technique | Why | Link |
|---|---|---|
| **VSM** (Variance Shadow Maps) | Store E[z], E[z²]; Chebyshev inequality → soft penumbra; filterable like a color texture | [Donnelly & Lauritzen 2006 paper](https://dl.acm.org/doi/10.1145/1111411.1111440) · [GPU Gems 3 Ch.8](https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-8-summed-area-variance-shadow-maps) |
| **PCSS** (Percentage-Closer Soft Shadows) | Contact-hardening: soft far, hard contact | [Fernando, NVIDIA PCSS](https://developer.download.nvidia.com/shaderlibrary/docs/shadow_PCSS.pdf) |
| **PCF** | Classic multi-tap compare | Covered in MSDN CSM article above |

### How engines do it
| Engine | Doc |
|---|---|
| UE4/5 Cascaded Shadow Maps (Directional) | Built into DirectionalLight; distance per cascade |
| UE5 Virtual Shadow Maps (Nanite-era) | [Virtual Shadow Maps](https://dev.epicgames.com/documentation/unreal-engine/virtual-shadow-maps-in-unreal-engine) |

### How we do it on Web
- Three `CSMShadowNode` + `VSMShadowMap` (Pipeline2 Stage 0)
- Discourse: [CSM on WebGPU showcase](https://discourse.threejs.org/t/cascaded-shadow-maps-csm-on-webgpu/84235)

### Status
**In progress** — Stage 0 cube validates VSM penumbra; outdoor cascade fit TBD.

---

# Step 2 — Geometry pass / G-Buffer (MRT)

### What
Rasterize visible opaque geometry into multiple render targets: depth, world normal, albedo, roughness/metal, motion vectors.

### Why
Deferred / deferred-hybrid lighting and *all* screen-space effects (AO, SSGI, volumetrics, TRAA) need geometry data *without* re-drawing the mesh.

### Proof
| Source | Link |
|---|---|
| Classic deferred shading overview | [Saito & Takahashi 1990](https://dl.acm.org/doi/10.1145/97880.97913) · modern survey: [Deferred Rendering (Wikipedia + refs)](https://en.wikipedia.org/wiki/Deferred_shading) |
| Killzone 2 deferred (industry popularizer) | Valient, *Deferred Rendering in Killzone 2* — [slides/PDF via advances.realtimerendering archives](https://www.guerrilla-games.com/read/deferred-rendering-in-killzone-2) |
| G-buffer as input to surfel GI | [webgiya G-buffer pass](https://github.com/jure/webgiya/blob/main/src/gbuffer.ts) |

### How we do it
Three WebGPU MRT via TSL: `mrt({ output, velocity })` in Pipeline2 — [WebGPURenderer docs](https://threejs.org/docs/#api/en/renderers/webgpu/WebGPURenderer), [TSL wiki](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language).

### Status
**Partial** — velocity + beauty MRT for TRAA; full albedo/normal GBuffer for AO/GI not yet first-class.

---

# Step 3 — Direct lighting (PBR + sun + IBL)

### What
For each pixel: sun × shadow × BRDF + image-based lighting from sky/env.

### Why
Cook–Torrance microfacet BRDF is the industry standard for dielectrics/metals. Real outdoor light is **sun (directional, high luminance) + sky (hemisphere / SH / env)**.

### Proof — PBR
| Source | Link |
|---|---|
| Disney Principled BRDF (SIGGRAPH course) | [Burley, *Physically-Based Shading at Disney*](https://media.disneyanimation.com/uploads/production/publication_asset/48/asset/s2012_pbs_disney_brdf_notes_v3.pdf) |
| Real Shading in Unreal Engine 4 | [Karis 2013](https://cdn2.unrealengine.com/Resources/files/2013SiggraphPresentationsNotes-26915738.pdf) |
| Filament PBR docs (excellent equations) | [Google Filament — Material Model](https://google.github.io/filament/Filament.html) |
| Three.js MeshStandardMaterial (GGX-based) | [MeshStandardMaterial](https://threejs.org/docs/#api/en/materials/MeshStandardMaterial) |

### Proof — Linear color / HDR
| Source | Link |
|---|---|
| sRGB vs linear (must not double-encode albedo) | [GPU Gems 3 Ch.24 — Importance of Being Linear](https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-24-importance-being-linear) |
| ACES / HDR pipeline overview | [Academy ACES](https://www.oscars.org/science-technology/sci-tech-projects/aces) · [Stephen Hill — Filmic Tonemapping](https://www.slideshare.net/ozlael/hable-john-uncharted2-hdr-lighting) (Hable Uncharted 2) |

### Status
**Partial** — MeshStandard + sun + env intensity; sun color not fully driven by atmosphere transmittance yet.

---

# Step 4 — Ambient Occlusion (GTAO-class)

### What
Screen-space estimate of how much ambient light is blocked by nearby geometry (crevices, contact with ground).

### Why
Without AO, objects float and rock cracks look flat. GTAO is radiometrically closer to ground-truth AO than classic SSAO hacks.

### Proof
| Source | Link |
|---|---|
| **GTAO paper (Activision)** | [Jimenez et al. — *Practical Real-Time Strategies for Accurate Indirect Occlusion*](https://www.activision.com/cdn/research/Practical_Real_Time_Strategies_for_Accurate_Indirect_Occlusion_NEW%20VERSION_COLOR.pdf) |
| Intel open-source XeGTAO (production-grade impl) | [GameTechDev/XeGTAO](https://github.com/GameTechDev/XeGTAO) |
| n8ao (used in our WebGL Pipeline v1) | [N8AO npm / GitHub](https://github.com/N8python/n8ao) |

### How engines do it
UE: GTAO / Lumen Screen Traces also fill near-field occlusion.  
See Lumen tech doc: screen traces first, then world method — [Lumen Technical Details](https://dev.epicgames.com/documentation/unreal-engine/lumen-technical-details-in-unreal-engine).

### Status
**WebGL only (n8ao)** — must port or reimplement for WebGPU Pipeline2.

---

# Step 5 — Indirect Global Illumination

### What
Light that bounced ≥1 time: cave floor lit by skylight after hitting rock, green bounce under canopy, color bleed.

### Why
Concept image is **dominated** by multi-bounce. Direct sun + hemi cannot produce warm floor under a skylight hole.

### Proof — Industry approaches

| Approach | Primary source |
|---|---|
| **Lumen** (UE5) — screen traces + SDF / HW RT | [Lumen Technical Details](https://dev.epicgames.com/documentation/unreal-engine/lumen-technical-details-in-unreal-engine) · [Lumen Global Illumination](https://dev.epicgames.com/documentation/unreal-engine/lumen-global-illumination-and-reflections-in-unreal-engine) |
| **GIBS / Surfels** (EA SEED → Frostbite) | [SIGGRAPH 2021 Advances — GIBS PDF](https://advances.realtimerendering.com/s2021/SIGGRAPH%20Advances%202021%20-%20Surfel%20GI.pdf) · [Course page](https://advances.realtimerendering.com/s2021/index.html) · [Talk video](https://www.youtube.com/watch?v=Uea9Wq1XdA4) |
| **GIBS shipping** (2024 update) | [Apers et al. SIGGRAPH 2024 PDF](https://advances.realtimerendering.com/s2024/content/EA-GIBS2/Apers_Advances-s2024_Shipping-Dynamic-GI.pdf) |
| **Kajiya** surfel grid (Embark) | [kajiya surfel shaders](https://github.com/EmbarkStudios/kajiya/tree/restir-meets-surfel/assets/shaders/surfel_gi) · [h3r2tic pipeline gist](https://gist.github.com/h3r2tic/ba39300c2b2ca4d9ca5f6ff22350a037) |
| **Webgiya** — full surfel GI on WebGPU | [Repo](https://github.com/jure/webgiya) · [Write-up](https://juretriglav.si/surfel-based-global-illumination-on-the-web/) |
| Classic light probes / irradiance volumes | [Ramamoorthi & Hanrahan SH irradiance](https://cseweb.ucsd.edu/~ravir/papers/envmap/envmap.pdf) |
| Screen-space GI surveys | Common in modern engines; Lumen’s “Screen Traces” section above |

### Surfels (deep dive sources used by webgiya)
| Topic | Link |
|---|---|
| Original surfel paper | Pfister et al. SIGGRAPH 2000 — *Surfels: Surface Elements as Rendering Primitives* ([ACM](https://dl.acm.org/doi/10.1145/344779.344936)) |
| MSME temporal filter (PICA PICA / RT Gems) | [Ray Tracing Gems Ch.25 (SEED)](https://media.contentapi.ea.com/content/dam/ea/seed/presentations/2019-ray-tracing-gems-chapter-25-barre-brisebois-et-al.pdf) |
| Moment Shadow Mapping (radial depth / leak fix) | [Peters & Peters / MSM](https://cg.ivd.kit.edu/english/peters/Publications.htm) · overview used in webgiya write-up |
| Path guiding (hemi bins) | Related: [Vorba et al. online path guiding](https://cgg.mff.cuni.cz/~jaroslav/papers/2014-onlinepg/2014-onlinepg-paper.pdf) (offline origin; real-time uses simplified grids) |

### Phased recommendation (with sources)
1. **Probes / SH** — ship outdoor ambient color (classic, low cost)  
2. **SSGI** — near bounce like Lumen screen traces  
3. **Surfels** — hero interiors (webgiya / GIBS)  

### Status
**Missing** — highest-impact gap for concept image.

---

# Step 6 — Physically based sky / atmosphere

### What
Render sky dome from Rayleigh + Mie + ozone scattering; derive sun disc color and ambient tints from same math.

### Why
Grey or photographic HDRI-only sky breaks coherence with sun shadows and fog. Atmosphere model makes sunset red sun + blue zenith *physically linked*.

### Proof
| Source | Link |
|---|---|
| **Hillaire 2020** (Epic; production sky used by UE Sky Atmosphere lineage) | [PDF: *A Scalable and Production Ready Sky and Atmosphere Rendering Technique*](https://sebh.github.io/publications/egsr2020.pdf) |
| Bruneton & Neyret precomputed atmosphere (classic) | [EGSR 2008 / project page](https://ebruneton.github.io/precomputed_atmospheric_scattering/) |
| UE Sky Atmosphere component | [Docs](https://dev.epicgames.com/documentation/unreal-engine/sky-atmosphere-component-in-unreal-engine) |
| Accessible implementation walkthrough | [Maxime Heckel — On Rendering the Sky](https://blog.maximeheckel.com/posts/on-rendering-the-sky-sunsets-and-planets/) |

### How we do it
`skyTSL.ts` / `atmosphereMath.ts` / GLSL `skyAtmosphere.ts` — Hillaire-class.

### Status
**Partial** — Stage 0 TSL sky works; not yet driving fog/sun/IBL as one system.

---

# Step 7 — Height fog / aerial perspective

### What
Exponential density that falls off with height; fog color blends toward sun along view ray (inscattering).

### Why
Distant mountains must desaturate toward sky color. Flat `FogExp2` grey fails the “AAA distance” look. UE’s Exponential Height Fog is the reference artist control set.

### Proof
| Source | Link |
|---|---|
| UE Exponential Height Fog | [Docs](https://dev.epicgames.com/documentation/unreal-engine/exponential-height-fog-in-unreal-engine) |
| Coupled volumetric extension | [Volumetric Fog](https://dev.epicgames.com/documentation/unreal-engine/volumetric-fog-in-unreal-engine) |
| Aerial perspective in Hillaire atmosphere | Same PDF as Step 6 — aerial perspective LUTs |
| Nishita et al. display of the Earth (foundational aerial) | Classic SIGGRAPH 1993 atmospheric scattering |

### Status
**WebGL HeightFog exists** (`heightFog.ts`) — orphaned; needs TSL port + sun-linked color.

---

# Step 8 — Volumetrics / God rays (concept-critical)

### What
Participating media: light shafts through dust/air; froxel 3D fog or post-process radial blur / raymarch.

### Why
`concepts/final_output.png` is **defined** by shafts through the cave mouth. No volume = no concept.

### Proof
| Source | Link |
|---|---|
| **GPU Gems 3 Ch.13** — god rays as post-process (crepuscular rays) | [Mitchell — Volumetric Light Scattering as a Post-Process](https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process) |
| UE Volumetric Fog (froxels + shadowing) | [Official docs](https://dev.epicgames.com/documentation/unreal-engine/volumetric-fog-in-unreal-engine) |
| Technical deep-dive write-up of UE volume fog | [iRendering — Exploring Volumetric Fog in UE](https://irendering.net/exploring-volumetric-fog-in-unreal-engine/) |
| Participating media theory | [GPU Gems — Volume Rendering Techniques](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-39-volume-rendering-techniques) |
| Shadow-map raymarch shafts (common real-time) | Combined practice: sample shadow map along view ray toward sun (see Gems 3 + modern blog implementations) |

### Implementation ladder
1. **Post radial blur** (Gems 3) — cheap shafts  
2. **Raymarch shadow map** — correct occlusion by rock/trees  
3. **Froxel volume** (UE) — true 3D density + multiple lights  

### Status
**Missing** — P0 for concept bar.

---

# Step 9 — Special geometry (foliage, water, particles)

### What
Alpha-tested canopy, instanced grass with wind, water refraction/reflection, dust particles in beams.

### Proof (selected)
| System | Source |
|---|---|
| Ghost of Tsushima foliage / grass | [GDC / SIGGRAPH talks — Sucker Punch grass](https://www.youtube.com/results?search_query=ghost+of+tsushima+grass+gdc) · community analyses of wind + density |
| SpeedTree / procedural trees | [ez-tree](https://github.com/dgreenheck/ez-tree) (our dep) |
| Water (FFT ocean / planar) | Three.js Water examples · [OceanThreejs](https://github.com/achrefelouafi/OceanThreejs) |
| UE water system overview | [Water System](https://dev.epicgames.com/documentation/unreal-engine/water-system-in-unreal-engine) |
| Fluffy grass reference (our sandbox) | `references/fluffygrass` + 0xca0a style instanced blades |

### Status
**Entities written, not wired** (terrain, conifer, ferns); grass in sandbox; water missing.

---

# Step 10 — Temporal Anti-Aliasing / Super Resolution

### What
Jitter camera each frame; reproject history via motion vectors; accumulate to kill aliasing and denoise stochastic effects (AO, soft shadows, GI, volumetrics).

### Why
MSAA does not help temporal shimmer on foliage or denoise GTAO. Modern AAA is temporal-first.

### Proof
| Source | Link |
|---|---|
| UE5 **TSR** (Temporal Super Resolution) | [Official docs](https://dev.epicgames.com/documentation/unreal-engine/temporal-super-resolution-in-unreal-engine) · [TSR FAQ](https://dev.epicgames.com/documentation/unreal-engine/temporal-super-resolution-frequently-asked-questions-for-unreal-engine) |
| Classic TAA survey / Karis | High-quality temporal supersampling literature (UE4 TAA lineage) |
| Three.js TRAA node | `three/addons/tsl/display/TRAANode.js` (used in Pipeline2) |
| Why velocity buffers matter | Any TAA paper; UE docs visualize disocclusion via velocity |

### Status
**Partial** — TRAA wired on real WebGPU; foliage must emit correct motion vectors for wind.

---

# Step 11 — Display post (HDR → film look)

Order that production uses (and we target):

```
HDR linear beauty
 → exposure (EV)
 → bloom (threshold + mip blur)
 → tonemap (ACES or AgX)
 → color grade
 → vignette + film grain
 → present sRGB
```

### Proof — Bloom
| Source | Link |
|---|---|
| Kawase / dual-filter / mip bloom practice | Common; Filament & UE bloom implementations |
| Why bloom *after* lighting, on HDR | Prevents “glowing grey”; only luminances > threshold bloom |

### Proof — Tonemap
| Source | Link |
|---|---|
| **ACES** filmic (UE default family) | [Academy ACES](https://www.oscars.org/science-technology/sci-tech-projects/aces) · three/postprocessing `ToneMappingMode.ACES_FILMIC` |
| **AgX** (Blender 4 default; often preferred for real-time) | [AgX (GitHub / Blender)](https://github.com/sobotka/AgX) · discussion of why ACES can crush + hue-shift |
| Hable Uncharted 2 curve (classic game filmic) | [John Hable — Filmic Tonemapping](http://filmicworlds.com/blog/filmic-tonemapping-operators/) |
| Three.js tonemapping modes | [Renderer.toneMapping](https://threejs.org/docs/#api/en/renderers/WebGLRenderer.toneMapping) |

### Proof — Color management
| Source | Link |
|---|---|
| Linear workflow | [GPU Gems 3 Ch.24](https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-24-importance-being-linear) |
| Three `outputColorSpace = SRGBColorSpace` | [Color management guide](https://threejs.org/docs/#manual/en/introduction/Color-management) |

### Status
**Partial** — ACES + bloom + TRAA; AgX, grain, full grade stack TBD.

---

# Step 12 — Present

### What
Write final LDR sRGB (or Display-P3 later) to canvas.

### Proof
WebGPU/WebGL canvas color space; Three docs above.

### Status
**Done** (basic).

---

# Cross-cutting proofs (why “beyond stock Three”)

| Claim | Evidence |
|---|---|
| Stock Three = forward lights + optional composer | [WebGLRenderer](https://threejs.org/docs/#api/en/renderers/WebGLRenderer) has no built-in GI/volumes |
| Unreal is multi-pass frame graph | Lumen + Volumetric Fog + TSR docs (linked above) |
| Surfel GI works on WebGPU in production-quality research | [webgiya](https://github.com/jure/webgiya) + [write-up](https://juretriglav.si/surfel-based-global-illumination-on-the-web/) |
| Compute-heavy pipelines are viable in browsers | WebGPU compute + three-mesh-bvh RT (webgiya BVH) |
| Concept image needs volumes + bounce | Visual reverse-engineer of `concepts/final_output.png` + UE cave lighting practice |

---

# Master bibliography (quick index)

### Epic / Unreal
1. [Lumen Technical Details](https://dev.epicgames.com/documentation/unreal-engine/lumen-technical-details-in-unreal-engine)  
2. [Volumetric Fog](https://dev.epicgames.com/documentation/unreal-engine/volumetric-fog-in-unreal-engine)  
3. [Exponential Height Fog](https://dev.epicgames.com/documentation/unreal-engine/exponential-height-fog-in-unreal-engine)  
4. [Sky Atmosphere](https://dev.epicgames.com/documentation/unreal-engine/sky-atmosphere-component-in-unreal-engine)  
5. [Temporal Super Resolution](https://dev.epicgames.com/documentation/unreal-engine/temporal-super-resolution-in-unreal-engine)  
6. [Virtual Shadow Maps](https://dev.epicgames.com/documentation/unreal-engine/virtual-shadow-maps-in-unreal-engine)  
7. [Karis — Real Shading in UE4 (2013)](https://cdn2.unrealengine.com/Resources/files/2013SiggraphPresentationsNotes-26915738.pdf)  

### Shadows
8. [MSDN Cascaded Shadow Maps](https://learn.microsoft.com/en-us/windows/win32/dxtecharts/cascaded-shadow-maps)  
9. [NVIDIA CSM PDF](https://developer.download.nvidia.com/SDK/10.5/opengl/src/cascaded_shadow_maps/doc/cascaded_shadow_maps.pdf)  
10. [VSM — GPU Gems 3 Ch.8](https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-8-summed-area-variance-shadow-maps)  
11. [MJP Shadow Techniques](https://therealmjp.github.io/posts/shadow-maps/)  
12. [PCSS NVIDIA](https://developer.download.nvidia.com/shaderlibrary/docs/shadow_PCSS.pdf)  

### AO / GI
13. [Jimenez GTAO PDF](https://www.activision.com/cdn/research/Practical_Real_Time_Strategies_for_Accurate_Indirect_Occlusion_NEW%20VERSION_COLOR.pdf)  
14. [XeGTAO](https://github.com/GameTechDev/XeGTAO)  
15. [GIBS SIGGRAPH 2021 PDF](https://advances.realtimerendering.com/s2021/SIGGRAPH%20Advances%202021%20-%20Surfel%20GI.pdf)  
16. [GIBS 2024 Shipping Dynamic GI](https://advances.realtimerendering.com/s2024/content/EA-GIBS2/Apers_Advances-s2024_Shipping-Dynamic-GI.pdf)  
17. [webgiya](https://github.com/jure/webgiya) · [write-up](https://juretriglav.si/surfel-based-global-illumination-on-the-web/)  
18. [Kajiya surfel GI](https://github.com/EmbarkStudios/kajiya)  
19. [RT Gems Ch.25 MSME](https://media.contentapi.ea.com/content/dam/ea/seed/presentations/2019-ray-tracing-gems-chapter-25-barre-brisebois-et-al.pdf)  

### Atmosphere / volume
20. [Hillaire EGSR 2020 PDF](https://sebh.github.io/publications/egsr2020.pdf)  
21. [Bruneton precomputed atmosphere](https://ebruneton.github.io/precomputed_atmospheric_scattering/)  
22. [GPU Gems 3 Ch.13 God Rays](https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process)  

### Color / PBR
23. [Disney PBS notes](https://media.disneyanimation.com/uploads/production/publication_asset/48/asset/s2012_pbs_disney_brdf_notes_v3.pdf)  
24. [Filament PBR](https://google.github.io/filament/Filament.html)  
25. [GPU Gems 3 Ch.24 Linear](https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-24-importance-being-linear)  
26. [Hable filmic operators](http://filmicworlds.com/blog/filmic-tonemapping-operators/)  
27. [AgX](https://github.com/sobotka/AgX)  

### Web stack
28. [Three WebGPURenderer](https://threejs.org/docs/#api/en/renderers/webgpu/WebGPURenderer)  
29. [Three TSL wiki](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language)  
30. [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)  

---

# Mapping: source → Elderwood phase

| Phase | Steps | Must-read first |
|---|---|---|
| **0 Foundation** | 1, 10, 11 | MSDN CSM, VSM Gems, Three TRAA, ACES |
| **1 Outdoor coherent** | 0, 3, 4, 6, 7, 11 | Hillaire, Height Fog, GTAO, Karis PBR |
| **2 Concept bar** | 5 (SSGI/probes), 8 | Gems 3 god rays, UE Volumetric Fog, Lumen overview |
| **3–4 Research** | 5 (surfels) | GIBS 2021 PDF, webgiya write-up, Kajiya |

---

# One-paragraph proof of the strategy

Unreal’s published docs show a **coupled** system: Directional Light + Sky Atmosphere + Exponential Height Fog/Volumetrics + Lumen + TSR + filmic post ([Epic docs above](https://dev.epicgames.com/documentation/unreal-engine/lumen-technical-details-in-unreal-engine)). Academic and SIGGRAPH sources justify each block: CSM (Microsoft/NVIDIA), VSM (Donnelly & Lauritzen), GTAO (Jimenez), atmosphere (Hillaire), god rays (Mitchell GPU Gems 3), surfel GI (GIBS / webgiya). Stock Three.js supplies mesh PBR and a post stack, **not** this full graph — therefore Elderwood must implement the missing passes on WebGPU/TSL, verified against `concepts/final_output.png`.

---

*Update this file when a pass lands; keep links as the source of truth for design arguments.*
