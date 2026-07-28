# Real work pipeline: Lumen-class GI + Static/Dynamic split

> **0–3 (WorldContext, shadows, GBuffer, direct PBR) = free.**  
> Already in Three + our Stage 0. Wire in ~5 minutes, stop talking about them.  
> Budget and Unreal bar live **after** direct lighting.

**North star:** `concepts/final_output.png`  
**Rule:** do not spend GPU on static work every frame.

---

## 1. What is already “free” (do not re-design)

| Step | Cost to us | Status |
|---|---|---|
| 0 WorldContext | glue | 5 min wire |
| 1 CSM + VSM | Stage 0 | done enough |
| 2 MRT / velocity | Pipeline2 | done enough |
| 3 Direct sun + IBL | MeshStandard / TSL | done enough |

**Action:** one composition root that puts sky + sun + shadow + opaque forward + TRAA/bloom.  
**Then never open those tickets again** until GI/volumes force a change.

---

## 2. The only graph that matters

```
┌──────────────────────────────────────────────────────────────────┐
│  FREE PATH (every frame, cheap)                                  │
│  shadow · opaque direct · sky · TRAA · bloom                     │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│  LUMEN-CLASS GI (the product)                                    │
│                                                                  │
│   ┌─ STATIC WORLD ──────────────────┐  ┌─ DYNAMIC ─────────────┐ │
│   │ terrain · rock · trunks · props │  │ camera · sun · foliage│ │
│   │ bake / slow refresh             │  │ characters · VFX      │ │
│   │ cheap sample every frame        │  │ full cost every frame │ │
│   └─────────────────────────────────┘  └───────────────────────┘ │
│                                                                  │
│  passes: ScreenTraces → WorldGI(static cache) → DynamicInject    │
│       → Compose → AO → Volume → Post                             │
└──────────────────────────────────────────────────────────────────┘
```

**Unreal Lumen does exactly this idea:**
- near field: **screen traces** every frame (cheap, dynamic-friendly)
- far / missing: **world representation** (SDF / surface cache / probes) that is **not fully rebuilt** every frame
- temporal accumulation so you pay over time, not all at once

Docs: [Lumen Technical Details](https://dev.epicgames.com/documentation/unreal-engine/lumen-technical-details-in-unreal-engine)

---

## 3. Lumen-like passes (what we actually build)

Not “one GI shader.” **Named passes** with static/dynamic ownership.

### Pass L1 — Screen Traces (every frame, dynamic)

**Job:** short-range bounce from GBuffer depth/normal/albedo.  
**Pays for:** contact bounce, moving camera, dynamic objects in view.  
**Cost:** medium, **must** stay half-res + temporal.

| | |
|---|---|
| UE parallel | Lumen Screen Traces first |
| Web | TSL compute/fullscreen, reproject with velocity |
| Static? | No — this is the dynamic near field |

**Proof:** [Lumen Technical Details](https://dev.epicgames.com/documentation/unreal-engine/lumen-technical-details-in-unreal-engine) (“Screen Traces are done first…”)

---

### Pass L2 — Static World Cache (rare / dirty)

**Job:** store multi-bounce irradiance for **static** geo (terrain, rock, architecture, tree trunks if not wind-lit).  
**Forms:**

| Option | When | Update |
|---|---|---|
| **A. Clipmap / brick irradiance volume** | forest + cave | only dirty bricks when sun moves a lot or geo edits |
| **B. Surfel / surface cache** (webgiya/GIBS) | hero interiors | age/recycle; not full rebuild |
| **C. Light probes + SH** | outdoor ambient | rebake on sun step (not every frame) |

**Key:** sample is O(1) per pixel/surfel. **Build** is amortized.

| | |
|---|---|
| UE parallel | Lumen Surface Cache / radiance cache (update subsets) |
| Surfel proof | [GIBS 2021](https://advances.realtimerendering.com/s2021/SIGGRAPH%20Advances%202021%20-%20Surfel%20GI.pdf) · [webgiya](https://github.com/jure/webgiya) |
| Probe classic | SH irradiance [Ramamoorthi](https://cseweb.ucsd.edu/~ravir/papers/envmap/envmap.pdf) |

**Budget law:**  
`staticCacheUpdateBudgetMs` e.g. **1.0–2.0 ms/frame max** — update N bricks/surfels per frame, never whole world.

---

### Pass L3 — Dynamic inject (every frame, small set)

**Job:** things that **cannot** live in static cache:

- wind foliage (if you want GI on leaves — often skip, use fake SSS)
- moving props / characters
- strongly animated lights (rare for us)

**Method:**
1. Tag layer: `STATIC` | `DYNAMIC`
2. Dynamic: only screen traces + short RT / local probes
3. Optional: project dynamics into a **small** dynamic probe shell around camera

**Do not** put entire forest canopy into full GI.

---

### Pass L4 — GI Compose

```
indirect = screenTrace
         + sample(staticCache, worldPos, normal)   // free-ish
         + dynamicInject
indirect *= albedo  // diffuse only first
beauty   = direct + indirect * giIntensity
```

Occlusion: GTAO multiplies ambient/indirect (half-res).

---

### Pass L5 — Volumes (after GI compose)

God rays / froxels — separate from GI.  
Static density fields (cave dust volume) can be **authored/static**; light shafts re-lit when sun moves.

---

## 4. Static vs Dynamic in compositing (budget model)

### Tags (must be in scene graph)

```
STATIC_OPAQUE     // terrain, rocks, trunks, buildings
STATIC_ALPHA      // far impostor canopy (optional)
DYNAMIC_OPAQUE    // player, moving props
DYNAMIC_FOLIAGE   // wind grass/leaves — direct+SSS, light GI
SKY_VOLUME        // sky, fog, shafts
```

### Who pays what each frame

| Pass | Static | Dynamic | Note |
|---|---|---|---|
| Shadow CSM | redraw casters (both) | same | later: static shadow cache for distant |
| Direct | draw both | draw both | unavoidable |
| Screen traces | yes (as GBuffer) | yes | shared |
| **Static cache sample** | **read only** | — | **no rebuild** |
| **Static cache update** | **N dirty cells** | never | amortized |
| Dynamic GI inject | — | small set only | hard cap |
| AO | full | full | half-res |
| Volume | density static OK | light dynamic | |
| TRAA/post | full | full | |

### Dirty rules (when static pays again)

| Event | Action |
|---|---|
| Camera move | **no** static rebuild — only sample + screen traces |
| Sun angle Δ < threshold | **no** full rebuild; optional slow morph |
| Sun angle Δ large / TOD scrub | mark all static dirty, rebuild **over many frames** |
| Static mesh edited | dirty local bricks only |
| Wind | foliage **not** in static GI |

This is how you stop “burning budget on static every frame.”

---

## 5. Target frame budget (High tier, 16 ms → 60 fps)

| Bucket | ms | Notes |
|---|---|---|
| Free path (shadow+direct+sky) | 4–6 | accepted |
| Screen traces | 1.0–1.5 | half-res |
| Static cache **sample** | 0.3–0.5 | |
| Static cache **update** | ≤ 1.5 | **hard cap** |
| Dynamic inject | ≤ 0.8 | hard cap |
| AO | 0.8–1.2 | |
| Volume / shafts | 1.0–2.0 | quality tier |
| TRAA + post | 1.0–1.5 | |
| **Headroom** | rest | foliage overdraw is the real enemy |

If static update would exceed cap → **skip**, keep last cache (temporal).  
Same as Lumen: quality converges over frames, never spikes.

---

## 6. What “Lumen with normal passes” means for us (concrete modules)

```
src/shared/engine2/
  pipeline2.ts          // FREE path only (keep thin)
  gi/
    screenTraces.ts     // L1 every frame
    staticCache.ts      // L2 irradiance volume OR surfel pool
    dynamicInject.ts    // L3
    giCompose.ts        // L4
  ao/
    gtao.ts
  volume/
    godRays.ts          // then froxels if needed
```

**Content tags:**
```
entities mark castStaticGi: true/false
forest scatter: trunks STATIC, needles DYNAMIC_FOLIAGE (or static if no wind GI)
```

---

## 7. Implementation order (hours, not months of theory)

### Day 0 — 5 minutes (done, stop)
Wire free path: sky + sun VSM + floor/content + TRAA.  
**No more design on 0–3.**

### Day 1 — Screen traces + compose
1. Depth/normal/albedo readable  
2. Half-res SSGI/screen-trace pass  
3. `beauty = direct + gi * albedo`  
4. Screenshot vs concept (near bounce only)

### Day 2 — Static cache
1. Clipmap irradiance volume around camera **or** brick grid for cave/forest floor  
2. Update only dirty + budget cap  
3. Compose: screenTrace + cacheSample  

### Day 3 — Dynamic policy
1. Layer tags  
2. Foliage out of static GI  
3. Cap dynamic inject  

### Day 4 — AO + god rays  
Concept bar: shafts + contact AO on top of GI.

### Later — Surfel upgrade  
Replace/augment static cache with webgiya-class surfels **only for hero interiors** (static).  
Outdoor stays volume/probes.

---

## 8. Static/dynamic compositing formula (final image)

```
// FREE
direct = shadeDirect(sun, shadow, BRDF)

// LUMEN-CLASS
st     = screenTraces(gbuffer, prevGi)              // dynamic near
sc     = sampleStaticCache(worldPos, N)             // static world, free sample
dyn    = dynamicInject(dynamicSet)                  // small

indirect = st + sc + dyn
indirect *= multiBounceScale                        // artistic

ao = gtao(depth, normal)
ambientTerm = indirect * ao

// VOLUME
vol = volumetricInscatter(sun, shadow, density)

// COMPOSE
hdr = direct + ambientTerm + vol + emissive

// DISPLAY
out = tonemap(bloom(traa(hdr)))
```

**Critical:** `sampleStaticCache` never rebuilds. Rebuild lives in a **separate budgeted job**.

---

## 9. Anti-patterns (budget killers)

| Bad | Why | Fix |
|---|---|---|
| Full-scene surfel rebuild every frame | static paid as dynamic | dirty + amortize |
| GI on every grass blade | foliage is millions of leaves | direct + SSS fake; no world GI |
| One giant GI pass | can’t skip static | split L1/L2/L3 |
| Re-baking probes every camera move | wrong dirty rule | only sun/geo dirty |
| Spending weeks on 0–3 polish | zero Unreal delta | freeze free path |

---

## 10. Sources that justify this split (only the load-bearing ones)

1. **Lumen: screen traces first, world method second, temporal**  
   https://dev.epicgames.com/documentation/unreal-engine/lumen-technical-details-in-unreal-engine  

2. **GIBS: surfel cache amortizes RT**  
   https://advances.realtimerendering.com/s2021/SIGGRAPH%20Advances%202021%20-%20Surfel%20GI.pdf  

3. **webgiya: same idea on WebGPU (pool + age + integrate budget)**  
   https://juretriglav.si/surfel-based-global-illumination-on-the-web/  
   https://github.com/jure/webgiya  

4. **God rays separate from GI**  
   https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process  

5. **AO multiplies indirect, not a GI replacement**  
   https://www.activision.com/cdn/research/Practical_Real_Time_Strategies_for_Accurate_Indirect_Occlusion_NEW%20VERSION_COLOR.pdf  

---

## 11. One-line strategy (updated)

> **Freeze 0–3.**  
> Ship **Lumen-shaped GI**: screen traces (dynamic) + **static irradiance cache with hard update budget** + small dynamic inject.  
> Compose so static is **sampled**, not **recomputed**.  
> Then volumes/AO/post.  
> That is the Unreal gap; everything else is assembly.

---

## 12. Immediate next action (no more docs spiral)

1. Keep Pipeline2 free path as-is.  
2. Add `gi/screenTraces.ts` + `giCompose` into post stack.  
3. Add `STATIC` layer + empty `staticCache` sample (black → grey fill) so compose path exists.  
4. Fill cache with real integrate under `maxMs`.  

**Screenshot gate:** cave/rock corner with visible bounce ≠ flat hemi.
