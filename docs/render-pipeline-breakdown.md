# Elderwood — Unreal-Class Render Pipeline Breakdown

**Goal:** not “a Skyrim-ish forest scene,” but a **visual / lighting / atmosphere bar at Unreal Engine 5**  
(concept: `concepts/final_output.png`).

**Prime law still holds:** a feature does not exist until seen in a screenshot.

---

## 0. What the concept image actually demands

Reverse-engineering `concepts/final_output.png` (cave skylight):

| Visual cue | What the engine must do |
|---|---|
| Blown-out opening + soft bloom | HDR linear beauty → filmic tonemap → multi-scale bloom |
| Soft contact on rock faces | Contact AO / GTAO, not just hard shadows |
| God rays / light shafts | Volumetric scattering (raymarch or epipolar) along sun |
| Dust motes in beams | Participating media + particulate (particles or noise in volume) |
| Warm bounce on floors / cold rock in shade | **Indirect diffuse GI** (Lumen-class approx, not hemisphere only) |
| Soft penumbra under ledges | Cascaded shadows + soft filter (VSM / PCSS / PCF wide) |
| Aerial haze depth | Height + distance atmosphere fog, sun-tinted |
| Micro surface detail | High-res PBR (albedo/normal/rough/AO), anisotropic roughness |
| Film grain / slight vignette | Post grade after tonemap |
| Single coherent sun | **One sun drives:** light, shadows, fog, sky, volumes, GI seed |

This is **not** achievable with:

```
MeshStandard + DirectionalLight + EnvMap + SMAA + Bloom
```

That is the *default Three.js ceiling*. We must go past it deliberately.

---

## 1. UE5 mental model vs Three.js defaults

### Unreal (Deferred / Lumen / Nanite era — simplified)

```
Geometry → GBuffer (deferred)
    → Direct lights + shadows (CSM / Virtual Shadow Maps)
    → Lumen GI (surfels / probes / screen traces)
    → Reflections (Lumen / SSR / cube)
    → Volumetrics (fog, god rays)
    → Sky atmosphere
    → Translucency
    → Temporal upsample / TSR
    → Bloom / exposure / color grade / grain
    → Output
```

Key property: **one coherent world lighting state** shared by every system.

### Stock Three.js (forward-ish)

```
Each mesh shades itself (lights + env)
    → optional shadow maps
    → optional EffectComposer (AO, bloom, SMAA)
    → canvas
```

Missing by default: deferred GBuffer, multi-bounce GI, volumetric fog, proper aerial perspective, virtual geometry, temporal accumulation beyond simple AA.

### Our stance

| Layer | Use stock Three | Custom / research |
|---|---|---|
| Mesh draw, instancing, PBR materials | yes (WebGPU/TSL) | — |
| CSM + soft shadows | partial (CSMShadowNode, VSM) | penumbra tuning, large outdoor cascades |
| Sky atmosphere | partial (Preetham / our TSL sky) | full Hillaire + multiple scatter |
| Height fog / aerial | partial (HeightFog GLSL) | port to TSL + volume couple |
| AO | n8ao (WebGL) | GTAO/HBAO on WebGPU |
| Bloom / tonemap / TRAA | yes | exposure lock, film grade |
| **GI (Lumen-like)** | **no** | surfel / probe / SSGI hybrid |
| **Volumetric god rays** | **no** | froxel or raymarch volume |
| Water / foliage SSS | partial | custom shaders |
| Nanite | no (browser) | LOD + virtual texture later |

**Webgiya** ([jure/webgiya](https://github.com/jure/webgiya)) proves surfel GI *can* run on WebGPU. It is a **reference for GI class**, not a drop-in for open-world forest (static indoor bias, cost, no foliage/alpha).

---

## 2. Target architecture (Elderwood Unreal-class)

```
                    ┌─────────────────────────────────────┐
                    │         WorldContext (single sun)   │
                    │  sunDir, sunColor, sky, wind, time  │
                    └─────────────────┬───────────────────┘
                                      │
┌─────────────────────────────────────▼─────────────────────────────────────┐
│                         FRAME GRAPH (WebGPU / TSL)                        │
├───────────────────────────────────────────────────────────────────────────┤
│ 0. Prep                                                                   │
│    · update time-of-day, wind, camera matrices, prev-frame matrices       │
│    · sun → shadow cascades + light color from atmosphere                  │
│                                                                           │
│ 1. Shadow maps (depth-only)                                               │
│    · CSM 3–4 cascades, VSM or PCSS-soft                                   │
│    · optional contact-hardening for near cascade                          │
│                                                                           │
│ 2. G-Buffer / MRT (or hybrid forward+)                                    │
│    · RT0: albedo (sRGB) + material flags                                  │
│    · RT1: normal (world) + roughness                                      │
│    · RT2: motion vectors                                                  │
│    · Depth                                                                │
│    · Optional: velocity already in MRT for TRAA                           │
│                                                                           │
│ 3. Direct lighting (HDR)                                                  │
│    · sun × shadow × N·L × BRDF                                            │
│    · sky IBL diffuse (SH or filtered env) + specular lobe                 │
│    · local lights later (optional)                                        │
│                                                                           │
│ 4. Indirect lighting (the Unreal jump)                                    │
│    · Phase A: screen-space GI / bent normals (cheap)                      │
│    · Phase B: world probes / irradiance volume                            │
│    · Phase C (research): surfel GI (webgiya-class) for hero interiors     │
│                                                                           │
│ 5. Ambient occlusion                                                      │
│    · GTAO / N8AO-class, half-res + temporal stabilize                     │
│                                                                           │
│ 6. Atmosphere & volumetrics                                               │
│    · sky background (Hillaire / TSL)                                      │
│    · height fog aerial perspective on surfaces                            │
│    · volumetric fog froxels OR god-ray raymarch (concept-critical)        │
│                                                                           │
│ 7. Transparent / special                                                  │
│    · foliage alpha, water, particles (dust, mist)                         │
│                                                                           │
│ 8. Temporal & spatial reconstruction                                      │
│    · TRAA (TSR-lite) using velocity + depth                               │
│                                                                           │
│ 9. Post (display)                                                         │
│    · exposure (fixed EV or mild auto)                                     │
│    · AgX / ACES filmic tonemap                                            │
│    · bloom (soft, thresholded)                                            │
│    · color grade (cool shadow / warm sun — Skyrim→cinematic)              │
│    · vignette + film grain (subtle)                                       │
│    · optional SMAA if TRAA off                                            │
│                                                                           │
│ 10. Present sRGB                                                          │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Pass-by-pass breakdown

### Pass 0 — Prep / WorldContext

**Inputs:** camera, time, TOD, wind, quality tier  
**Outputs:** uniforms bound to every later pass  

```
sunDir, sunColor, skyColor, zenith, horizon
fog params, wind vector, time, prevViewProj
cascade splits, exposure EV
```

**UE parallel:** DirectionalLight + SkyAtmosphere + ExponentialHeightFog driven as one system.

**Rule:** no material invents its own sun color.

---

### Pass 1 — Cascaded Soft Shadows

| Item | Target |
|---|---|
| Technique | CSM (4 cascades outdoor; tight single cascade for interiors) |
| Filter | VSM (current Stage 0) or PCSS for contact-hardening |
| Map size | 2048–4096 per cascade (quality tiers) |
| Far | outdoor ~200–400 m; near cascade < 20 m high res |

**Concept image needs:** soft penumbra on rock, not hard 1-texel edges.

**We have:** `CSMShadowNode`, `VSMShadowMap`, Stage 0 cube test.  
**Gap:** outdoor-scale cascade fit, fade between cascades, receiver bias on foliage.

---

### Pass 2 — Geometry / G-Buffer

Two viable strategies:

| Strategy | Pros | Cons |
|---|---|---|
| **A. Hybrid forward+** (draw lit once, MRT depth/normal/velocity) | Fits Three materials, less rewrite | Harder multi-light / deferred GI |
| **B. Full deferred** | Classic UE-like, clean GI/AO inputs | Rewrite materials, transparency pain |

**Recommendation for Elderwood:** start **A** (forward beauty + depth/normal/velocity MRT), add deferred only where GI/AO needs it. Three WebGPU already uses `mrt({ output, velocity })` in Pipeline2.

**GBuffer fields (minimum for Unreal-class post):**

```
depth          float
normal         rgb10a2 or rgb16f
albedo         rgba8 sRGB
roughness/metal packed
velocity       rg16f
```

---

### Pass 3 — Direct Lighting

Physically plausible:

```
L_direct = sunIntensity * sunColor * shadow * BRDF(N, V, L, roughness, F0)
L_sky    = diffuseIBL(N) * AO + specularIBL(R, roughness)
L_emit   = emission
```

- Albedo sRGB → linear once  
- No double tonemap  
- Exposure applied **only** in post  

**We have:** MeshStandard + Directional + Hemisphere + env intensity.  
**Gap:** accurate sun spectral color from atmosphere, shadow-linked ambient (not flat hemi), specular IBL from real sky (not just HDRI blob).

---

### Pass 4 — Indirect GI (the hard Unreal step)

This is what separates “nice Three scene” from “looks like Lumen cave.”

#### 4A. Cheap / shippable first (forest outdoor)

| Method | Look | Cost | Fit |
|---|---|---|---|
| Sky SH + multi-bounce bake probes | soft ambient color bleed | low | open forest |
| SSGI (screen-space) | near-field bounce | medium | close rock / trunks |
| Bent-normal AO + sky | contact + sky occlusion | low | always |

Outdoor forest mostly needs **sky occlusion + soft multi-bounce from canopy**, not full path-traced interiors.

#### 4B. Concept-level interiors (cave / mines)

Concept image is **dominated by multi-bounce**: light enters hole → hits floor → fills cave.

| Method | Notes |
|---|---|
| Surfel GI (webgiya-class) | Best quality; static-ish geo; research |
| Clipmap irradiance volume | Classic UE pre-Lumen; good for caves |
| RTX / HW RT | **Not available** on WebGPU |

**Pipeline insertion:**

```
GBuffer → GI resolve → modulate albedo (diffuse only)
                    → optional specular separate
```

**Phasing:**

1. **Now:** IBL + hemi + AO  
2. **Next:** SSGI + probe volume for hero areas  
3. **Research:** surfel GI for cave/interior showcase shot  

---

### Pass 5 — Ambient Occlusion

| | |
|---|---|
| Target | GTAO quality (UE default family) |
| Res | half-res + bilateral upsample |
| Temporal | stabilize with velocity (feeds TRAA) |
| Current | n8ao on WebGL Pipeline v1; **missing on WebGPU Pipeline2** |

**Concept:** rock crevices and contact with ground must darken without crushing blacks.

---

### Pass 6 — Atmosphere & Volumetrics

#### 6.1 Sky

Hillaire / Bruneton-class atmosphere (we have TSL + GLSL prototypes):

- Rayleigh + Mie + ozone  
- Sun disc transmittance  
- Multiple scattering approx  
- Ground bounce tint  

#### 6.2 Height fog (surfaces)

UE Exponential Height Fog:

```
fogAmount = 1 - exp(-density * opticalDepthAlongRay)
fogColor  = mix(horizon, sunInscatter, phase(sun, view))
```

Already sketched in `heightFog.ts` (WebGL). **Must port to TSL** and share colors with sky.

#### 6.3 Volumetric fog / god rays (concept-critical)

Concept image **fails without** light shafts + dust.

| Approach | Quality | Cost | Notes |
|---|---|---|---|
| Epipolar god rays (2D post) | medium | low | shafts only, no true volume |
| Raymarch shadow map (depth) | good shafts | medium | classic “crepuscular rays” |
| Froxel volume (UE style) | best | high | 3D grid, temporal accumulate |

**Recommendation:**

1. Shadow-map raymarch god rays for hero sun beams  
2. Later froxels if outdoor haze needs true 3D density  

Dust: GPU particles in beam cone + subtle noise in volume march.

---

### Pass 7 — Special geometry

| System | Shading needs |
|---|---|
| Terrain | splat (height+slope), no tiling, shadow receive |
| Trees | alpha-test canopy, wind, LOD, fake SSS backlit needles |
| Grass | instanced blades, wind, translucency, ground align |
| Water | reflection + refraction + shore foam + depth absorb |
| Particles | additive dust, soft mist cards |

Foliage is **forward transparent / alpha-tested** after opaque GBuffer, still affected by fog/shadows.

---

### Pass 8 — Temporal reconstruction (TRAA / TSR-lite)

```
history = sample(prevColor, uv + velocity)
output  = blend(current, history, confidence(depth, velocity, luma))
```

- Required for noisy AO, soft shadows, SSGI, volumetrics  
- Pipeline2 already wires TRAA when real WebGPU  
- Must output **correct velocity** from all moving foliage (wind → motion vectors)

---

### Pass 9 — Display post

Order matters (UE-like):

```
HDR beauty (linear)
  → exposure (EV)
  → bloom (extract bright → mip blur → add)
  → tonemap (AgX preferred; ACES ok)
  → color grade (lift/gamma/gain or hue/sat/contrast)
  → vignette
  → film grain
  → (SMAA if no TRAA)
  → sRGB present
```

**Concept:** hot white core of skylight, soft bloom halo, slight grain, cinematic contrast — not over-bloomed game UI glow.

**We have (v1 WebGL):** N8AO → Bloom → ACES → grade → vignette → SMAA  
**We have (v2 WebGPU):** TRAA → bloom → ACES on renderer  
**Gap:** AgX, grain, grade stack, exposure lock, bloom only after GI/volumes.

---

## 4. Buffer & dataflow diagram

```
                    ┌──────── shadow depth[cascades] ────────┐
                    │                                        │
Camera ──► Opaque draws ──► MRT ──► albedo│normal│rough│vel  │
                    │           │                            │
                    │           └─► depth ───────────────────┤
                    │                                        │
                    ▼                                        ▼
              Direct light ◄──── sun + CSM soft ◄────────────┘
                    │
                    ├─► AO (half) ──┐
                    ├─► GI resolve ─┼─► compose HDR
                    └─► volumetrics ┘
                              │
                              ▼
                         TRAA history
                              │
                              ▼
                    bloom · tonemap · grade · grain
                              │
                              ▼
                           swapchain
```

---

## 5. “Standard Three.js” vs our target (gap table)

| Capability | Stock Three | Elderwood now | Unreal target | Priority |
|---|---|---|---|---|
| PBR materials | yes | yes | yes | — |
| Soft CSM shadows | partial | Stage 0 VSM/CSM | outdoor soft CSM | P0 |
| Physically sky | addon Sky | TSL atmosphere | full Hillaire + MS | P0 |
| Height / aerial fog | basic Fog | HeightFog (orphaned) | UE height fog + sun inscatter | P0 |
| AO | no | n8ao (WebGL only) | GTAO temporal | P0 |
| Filmic + bloom + TRAA | partial | Pipeline2 partial | full display chain | P0 |
| God rays / volumetrics | no | no | shafts + dust | **P0 for concept** |
| Multi-bounce GI | no | no | probes / SSGI / surfel | **P1** |
| Water | examples | no | shore + SSR-ish | P1 |
| Foliage wind + SSS | custom | partial entities | full | P1 |
| Motion vectors on wind | no | no | required for TRAA | P1 |
| Virtual geometry | no | no | LOD + impostors | P2 |
| Surfel GI (webgiya) | — | — | hero interiors | P2 research |

---

## 6. Quality tiers (same pipeline, different budgets)

| Tier | Shadows | AO | GI | Volume | AA | Target |
|---|---|---|---|---|---|---|
| Low | 2 cascade 1024 PCF | half AO | IBL only | shafts off | SMAA | 60 fps mid |
| Medium | 3 cascade 2048 VSM | GTAO half | IBL+SSGI | cheap shafts | TRAA | 45–60 |
| High | 4 cascade 2048–4k | full GTAO | probes+SSGI | froxel/raymarch | TRAA | 45 on high GPU |
| Cinematic | high + hero surfel GI | full | full | full + particles | TRAA | screenshot / trailer |

---

## 7. Content pipeline (forms before glow)

Unreal look dies if geometry is primitive. Order stays:

1. **Form** — terrain relief, tree silhouettes, rock LODs, grass density  
2. **Material** — authored PBR, correct color space, detail maps  
3. **Lighting** — sun + sky + shadows + fog  
4. **GI / volume** — bounce + shafts  
5. **Post** — film grade  

Post never fixes bad forms.

---

## 8. Recommended implementation phases

### Phase 0 — Foundation (current)

- [x] WebGPU renderer  
- [x] TSL sky prototype  
- [x] VSM + optional CSM  
- [x] TRAA + bloom scaffold  
- [ ] Close Stage 0: perfect penumbra, no light-bleed, stable TRAA  

### Phase 1 — Coherent outdoor lighting (must ship)

1. WorldContext single-sun drive  
2. Port HeightFog + sky tints to TSL  
3. Outdoor CSM fit to terrain  
4. WebGPU AO (port or rewrite n8ao-class)  
5. Full post: AgX, grade, grain  
6. Re-wire terrain + trees + grass on Pipeline2  

**Exit criteria:** forest vista with depth haze, soft shadows, no milky fog, ≥45 fps.

### Phase 2 — Concept bar (god rays + bounce)

1. Shadow-map god-ray / volumetric shaft pass  
2. Dust particles in beams  
3. SSGI or probe volume for near bounce  
4. Cave / glade hero shot matching concept mood  

**Exit criteria:** screenshot competes with `concepts/final_output.png` on *mood* (not polycount).

### Phase 3 — Unreal-class polish

1. Water  
2. Better foliage SSS + wind MVs  
3. Quality tiers  
4. Optional surfel GI experiment for interiors  

### Phase 4 — Research ceiling

- Webgiya-style surfel GI on static hero mesh sets  
- Froxel volumetrics  
- Virtual texturing / aggressive LOD  

---

## 9. Concrete frame schedule (target High tier)

| Step | Pass | Rough budget |
|---|---|---|
| 1 | CSM shadows ×4 | 1.5–3 ms |
| 2 | Opaque scene + MRT | 2–4 ms |
| 3 | AO half-res | 0.8–1.5 ms |
| 4 | SSGI / probes | 1–3 ms |
| 5 | Volumetric shafts | 1–2 ms |
| 6 | Transparent foliage/particles | 1–2 ms |
| 7 | TRAA | 0.5–1 ms |
| 8 | Bloom + tonemap + grade | 0.5–1 ms |
| **Total** | | **~8–17 ms** (60–120 Hz headroom) |

Open-world foliage is usually the real cost — **instancing + LOD** dominate more than post.

---

## 10. Design laws (non-negotiable)

1. **One sun.** Light, shadow, fog, sky, volumes, GI seed share `WorldContext`.  
2. **Linear HDR until tonemap.** No tonemap in materials.  
3. **Albedo sRGB / data linear.** Never double-correct.  
4. **Fog is half the AAA distance look.** Grey fog = fail.  
5. **GI and volumes are not optional for concept bar** — bloom alone is cheating.  
6. **Verify with shots.** Wide + close. Blank / errors = fail.  
7. **Quality tiers scale passes, not art direction.**  

---

## 11. Relation to existing code

| Path | Role going forward |
|---|---|
| `shared/engine2/*` | **Active** — WebGPU foundation |
| `shared/engine/*` | Reference algorithms (HeightFog, softShadows, atmosphere) to **port** |
| `entities/*` | Content modules; reattach after foundation |
| `sandbox/fluffygrass` | Grass algorithm source |
| `concepts/final_output.png` | **Visual north star** |
| webgiya (external) | GI research reference, not Phase 1 dependency |

---

## 12. Success scorecard (updated)

| Category | Unreal bar (3) |
|---|---|
| Art direction | concept mood: shafts, bounce, film grade |
| Terrain | relief + splat, grounded contact shadows |
| Foliage | density, wind, SSS, no floaters |
| Trees | structure + LOD + canopy light |
| Water | reflective + shore (when present) |
| Sky / volume | atmosphere + **god rays** |
| Lighting | soft CSM + coherent sun + ambient |
| **GI** | visible multi-bounce in enclosed spaces |
| Post | AgX, bloom, grade, grain, TRAA |
| Perf | ≥45 fps 1600×900 medium tier |

**Automatic fail:** blank canvas, console errors, floating props, z-fight, over-bloom, grey fog, hard shadow teeth, no volume when concept requires it.

---

## 13. One-line strategy

> **Build a UE-shaped frame graph on WebGPU:**  
> CSM soft shadows → GBuffer/MRT → direct + AO → **GI** → **volumetrics** → TRAA → filmic post,  
> all driven by one sun — then put forest content into that graph.  
> Standard Three pipeline is the floor, not the ceiling.

---

*Living document. Update when a pass lands and is verified by screenshot.*
