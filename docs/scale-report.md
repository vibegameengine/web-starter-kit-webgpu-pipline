# Scale report — what the GI does when the world stops being a Cornell box

Every claim this GI system has made so far was measured on 96 triangles inside a
13 m room. This document re-measures the same claims on a 400 m landscape and says,
for each, whether it scales, degrades, or fails outright.

Nothing here is an impression. Every number below came out of `window.__scale()` via
`scripts/scale.mjs`, and every screenshot referenced was looked at.

---

## How to reproduce

```bash
# both reference scenes, side by side
node scripts/scale.mjs --json shots/scale/scale.json

# sweep the BVH by terrain density
node scripts/scale.mjs --wait 180000 \
  --q "hud=0&split=off&mover=0&bake=2000&scene=large&seg=16" \
  --q "hud=0&split=off&mover=0&bake=2000&scene=large&seg=64" \
  --q "hud=0&split=off&mover=0&bake=2000&scene=large&seg=128"

# sweep it by instance count
node scripts/scale.mjs --q "hud=0&split=off&mover=0&scene=large&grass=60000&ferns=20000"

# pictures
node scripts/capture-chrome.mjs shots/scale/large-vista.png \
  --url "http://127.0.0.1:5193/?hud=0&split=off&scene=large&mover=0&bake=6000" \
  --wait 120000 --w 1600 --h 900
```

Scene knobs live on the URL and are read in `src/widgets/world/largeScene.ts`:
`?scene=large&size=400&chunks=4&seg=32&grass=4000&ferns=1200&rocks=150&trees=6&cam=vista|closeup|ground`.

Measured on: NVIDIA Ada (Lovelace), Chrome/WebGPU/D3D11, 1600×900, 120 Hz display.

---

## The two scenes

| | cornell | large |
|---|---|---|
| meshes | 8 | 31 |
| `InstancedMesh` / instances | 0 / 0 | 3 / 5,350 |
| unique materials (with a `map`) | 3 (0) | 31 (31) |
| world bounds | 8.2 × 6.2 × 8.1 m | 400 × 132 × 400 m |
| bounds diagonal | 13.0 m | 580.8 m |
| raster triangles | 96 | 168,252 |
| lit surface area (single copy) | 580 m² | 458,073 m² |
| alpha-tested meshes | 0 | 3 |

`large` is a chunked heightfield (`src/entities/terrain`), two layers of instanced
alpha-cut ground cover (`src/entities/foliage`), instanced boulders
(`src/entities/rocks`) and six ez-tree procedural trees (`src/entities/trees`), under
one directional sun. It is not pretty and is not trying to be. It is the smallest
thing that behaves like a forest to every part of the pipeline that charges for size.

Wide vista: `shots/scale/large-vista.png`.
Instanced ground cover close up: `shots/scale/large-closeup.png`.

---

## 1. The scene BVH is one flat structure, uploaded whole

`src/shared/gi/surfel/sceneBvh.ts`

| | cornell | large (defaults) |
|---|---|---|
| triangles | 96 | 168,252 |
| BVH nodes | 81 | 146,385 |
| build wall-clock | 0.7 – 4.3 ms | 543 – 618 ms |
| GPU storage buffers | 16.8 kB | 28.2 MiB |
| fraction of drawn triangles traced | 100 % | 100 % |

Bytes per triangle are constant at **176 B** (position + normal + colour, all
non-indexed, plus the node array). Build time and memory are both linear in triangles:

| terrain `seg` | triangles wanted | in BVH | build | buffers | dropped |
|---|---|---|---|---|---|
| 16 | 143,676 | 143,676 | 501 ms | 24.0 MiB | — |
| 32 | 168,252 | 168,252 | 551 ms | 28.2 MiB | — |
| 64 | 266,556 | 266,556 | 889 ms | 45.1 MiB | — |
| 96 | 430,396 | 430,396 | 1,264 ms | 73.2 MiB | — |
| 128 | 659,772 | **499,486** | 1,363 ms | 85.6 MiB | **24.3 % of the scene** |

And by instance count, at `seg=32`:

| instances | triangles wanted | in BVH | build | buffers | dropped |
|---|---|---|---|---|---|
| 5,350 | 168,252 | 168,252 | 543 ms | 28.2 MiB | — |
| 16,150 | 227,452 | 227,452 | 769 ms | 37.2 MiB | — |
| 40,150 | 359,452 | 359,452 | 1,028 ms | 57.4 MiB | — |
| 80,150 | 579,452 | **498,574** | 1,286 ms | 77.3 MiB | **six whole trees** |

**Verdict: FAILS OUTRIGHT.**

Not "gets slow". `BVH_TRIANGLE_BUDGET = 500_000` (`sceneBvh.ts:41`) is a hard cap, and
past it whole meshes are refused and logged as errors:

```
[BVH:static] DROPPED "grass_cluster" — 4000 instance(s) × 6 triangles = 24000 would
take the BVH past its 500000 triangle budget. This geometry is INVISIBLE to the ray
tracer: it casts no indirect shadow and bleeds no colour.
```

The budget is exhausted by **0.16 km² of terrain carrying 0.7 scatter instances per
square metre**. That is one grass clump per 1.4 m — sparser than any forest floor this
project intends to ship. Scaling the same density to a Skyrim-shaped 40 km² world gives
~125 M triangles and ~20 GiB of storage buffers; it would not run slowly, it would fail
to allocate.

The failure is structural, not a constant to be tuned. One flat BVH means memory is a
function of *world size*, and the tracer's cost per ray is a function of *world
complexity*, neither of which is bounded by anything on screen.

**What Lumen does instead.** It does not trace triangles at distance at all. Each mesh
gets an offline per-mesh signed distance field; those are composited at runtime into a
**Global Distance Field** held as a clipmap of four volume textures centred on the
camera (default ~200 m reach), sphere-marched at cost independent of triangle count and
at memory independent of world size. Past the global SDF there is the **Far Field**, a
second coarser clipmap out to ~1 km, and past that the sky. Triangle tracing (hardware
ray tracing against a two-level BVH with per-instance transforms) is used only for the
near field on hardware that has it, and even then against streamed-in instances rather
than one merged blob.

### The instancing bug, and what it now costs

`sceneBvh.ts` used to treat `InstancedMesh` as a plain `Mesh` and bake one copy with the
object's own world matrix. That was fixed (working copy, `gatherBvhGeometries`) before
this scene first booted, so **the pre-fix binary could not be run** — the file belongs
to another agent and reverting it was not an option. What can be stated exactly, from
the census the probe takes independently of the BVH:

* Measured now: **168,252 of 168,252** drawn triangles are in the BVH — 100.00 %.
* Pre-fix semantics, applied to this scene's census: `singleCopyTriangles = 127,542`,
  so **40,710 triangles (24.2 %) would be missing**, and **5,347 of 5,350 instances
  (99.94 %)** would have collapsed onto the `InstancedMesh` origin.
* For the ground cover specifically: **90 of 40,800 triangles** would have been traced
  — **0.22 %** — with the surviving three sitting in a heap at the world origin,
  casting occlusion that nothing on screen matches.

The fix works. The budget it came with is now the binding constraint instead.

---

## 2. The lightmap atlas gives every quad the same number of texels

`src/shared/gi/bake/lightmapUv.ts`

| | cornell | large |
|---|---|---|
| meshes / charts | 8 / 48 | 31 / **39,091** |
| atlas cell grid | 7 × 7 | **198 × 198** |
| texels per chart edge (512 atlas) | 73 | **2.59** |
| metres per texel, aggregate | **0.063** | **1.634** |
| metres per texel, median | 0.125 | 2.812 |
| metres per texel, p95 | 0.146 | **52.28** |
| p95 / median spread | 1.17× | **18.6×** |

Three separate failures, measured separately.

**(a) Density.** 1.63 m/texel aggregate — **26× coarser than the Cornell box**. A texel
covers a patch bigger than a person. Nothing resembling a contact shadow, a foliage
shadow, or a colour bleed survives at that resolution.

**(b) Uniformity.** p95 is 18.6× the median, against 1.17× on Cornell. The unwrapper
documents its own assumption — per-face 0..1 UVs, four vertices per quad — and a
triangulated heightfield violates it, so charts are not merely small but wildly
unequal. The baked atlas is visible in the right pane of
`shots/scale/large-lightmap.png`: a shredded field of 2-texel rectangles, most of them
black.

**(c) The escape hatch is closed.** Raising the atlas to 1024 improves density to
0.817 m/texel and then hits the ceiling `src/app/main.ts` already warns about:

```
[lightmap] atlas coverage 572373/1048576 texels (54.6%)
[lightmap] seeded 262144 surfels from the atlas
[lightmap] surfel pool exhausted: 262144/572373 covered texels got a surfel;
           the rest will bake black. Lower ?lm=
```

**45.8 % of covered texels got a surfel.** The other 54.2 % bake black. Even at 512,
where the pool does fit (142,825 covered texels), **12,769–14,345 texels come out
black** and mean baked irradiance is **0.0146** against Cornell's **0.1696** — a factor
of 11.6 dimmer, on a scene that is outdoors and better lit.

**(d) Instanced geometry cannot have a lightmap at all.** An `InstancedMesh` has one
`uv1`, so every instance samples the same texels. Measured:

| shared chart | instances | world area | atlas share | effective |
|---|---|---|---|---|
| `grass_cluster` | 4,000 | 9,131 m² | 11.6 texels | **28.1 m/texel** |
| `fern` | 1,200 | 5,038 m² | 7.7 texels | **25.5 m/texel** |
| `rocks` | 150 | 6,660 m² | 11.8 texels | **23.8 m/texel** |

This is not a density loss, it is a category error. A lightmap stores world-space
radiance; four thousand grass clusters standing in four thousand different places
cannot share one.

**Verdict: FAILS OUTRIGHT**, in four independent ways, any one of which is
disqualifying.

**What Lumen does instead.** There is no lightmap. Radiance for a surface lives in the
**Surface Cache**: per-mesh cards captured into atlas pages, allocated and streamed by
**screen** size, so texel density tracks the camera and is bounded by screen resolution
rather than by world area. A mesh that is 8 pixels on screen gets an 8-pixel card
whether it is a pebble or a mountain, and instances share the *card layout* but get
their own lighting through the world-space **radiance cache clipmap** — a probe grid
centred on the camera, which is where far-field indirect actually comes from.

---

## 3. The diffuse array allocates a full 1024² layer per material

`src/shared/gi/surfel/diffuseArray.ts:44,69,83`

| | cornell | large |
|---|---|---|
| unique materials | 3 | 31 |
| array layers × size | 3 × 1024² RGBA8 | 31 × 1024² RGBA8 |
| total | **12.0 MiB** | **124.0 MiB** |
| per layer | 4.0 MiB | 4.0 MiB |
| `generateMipmaps` | false | false |

4 MiB per material, flat, regardless of what the material needs. Linear and unbounded
in material count: 40 forest materials is 160 MiB, 100 is 400 MiB, and none of it is
related to how much of the screen those materials occupy.

Two specifics from this scene worth naming:

* **16 of the 31 layers are the same texture.** The terrain's per-chunk materials share
  one `Grass004_2K` colour map and differ only in a tint multiplier. That is 64.0 MiB
  — over half the array — spent on sixteen near-identical copies of one image.
* **Source is 2048², layer is 1024², and there are no mips.** Rays sample mip 0, so a
  hit 200 m away reads a full-rate 1024² texture. There is no level of detail to fall
  back to, which is both an aliasing source and a cache-thrash source on every long ray.

**Verdict: DEGRADES**, predictably and steeply — linear in a count that has nothing to
do with what is visible, with no mip chain to soften the cost.

**What Lumen does instead.** Surface Cache pages carry mips and are streamed by screen
coverage, with eviction. Material data resident in memory is a function of what the
camera can see this frame, not of how many materials the level contains.

---

## 4. The surfel pool is allocated whole at boot

`src/shared/gi/surfel/surfelPool.ts:104-175`, `constants.ts:14`

Bytes per surfel, reconstructed term by term from `ensureCapacity`:

| buffer | bytes/surfel |
|---|---|
| packed struct (`posb` + `normal` + `age`) | 32 |
| free-list stack | 4 |
| moments, double-buffered (20 floats × 2) | 160 |
| touched flags | 4 |
| SLG guiding lobes (72 floats) | 288 |
| debug readback (vec4) | 16 |
| debug exec | 4 |
| radial depth atlas (4×4 × vec4) | 256 |
| **total** | **764** |

`MAX_SURFELS = 262,144`, allocated unconditionally at construction:

**191.0 MiB of GPU storage buffers, plus a mirrored 191.0 MiB of JS typed arrays —
382 MiB, before a single frame is drawn.**

| | cornell | large |
|---|---|---|
| surfels alive (runtime GI, 4 s warm-up) | 3,088 | 8,225 |
| pool utilisation | **1.18 %** | **3.14 %** |
| bytes actually carrying radiance | 2.2 MiB | 6.0 MiB |

A world 45× larger in linear extent uses 2.7× more surfels and still touches 3 % of the
pool. 97 % of 382 MiB is reserved and never written.

Meanwhile the same pool is simultaneously **too small**: the lightmap bake fills it
completely (100 % at `lm=1024` on the large scene, 56.9 % at `lm=512` on Cornell) and
then runs out, as recorded in §2.

**Verdict: DEGRADES**, but in the opposite direction from the others — this is a sizing
failure, not a scaling one. One fixed number is asked to be both a runtime cache budget
(where it is 30× too large) and a bake budget (where it is 2× too small).

**What Lumen does instead.** Neither the surface cache nor the radiance-cache probe
grid is a fixed reservation. Both are pools sized against screen resolution and quality
level, populated by streaming with explicit eviction, so occupancy tracks what is being
looked at. Nothing is reserved for a world that might exist.

---

## 5. The surfel hash grid — the part expected to scale

`src/shared/gi/surfel/surfelHashGrid.ts`, `constants.ts:5,6,12,13`

Geometry of the clipmap, from the constants: 8 cascades × 32³ cells, inner cell
diameter 0.2 m, cascade *c* half-extent = 3.2 · 2^c m.

| cascade | 0 | 3 | 5 | 7 |
|---|---|---|---|---|
| half-extent from camera | ±3.2 m | ±25.6 m | ±102.4 m | **±409.6 m** |

Surfel world radius, from `surfel_radius_for_pos` = `0.24 · max(1, d / 3.2)`:

| distance | 10 m | 50 m | 100 m | 200 m | 400 m |
|---|---|---|---|---|---|
| surfel radius | 0.75 m | 3.75 m | 7.50 m | 15.0 m | 30.0 m |

Measured on the large scene: **8,225 surfels for 458,073 m² of lit surface — 56 m² of
surface per surfel.** The grid did not fall over, did not overflow, and did not need a
single constant changed.

**Verdict: SCALES geometrically, DEGRADES in fidelity — and the degradation is
visible.**

* **Reach.** ±409.6 m around the camera covers this 400 m terrain, and the scene
  diagonal is 580.8 m, so a camera at one corner has the far corner (566 m) outside the
  clipmap entirely. It is adequate here and would not be for a 1 km level.
* **Footprint.** At 100 m a surfel is 7.5 m across. Every grass cluster in this scene is
  0.5–1.9 m and every fern 0.7–1.6 m. **Past roughly 7 m from the camera, a blade of
  grass is smaller than one surfel**, so foliage is lit by cache entries that also cover
  the ground underneath it. That is not a bug in the grid; it is the grid working as
  specified, being asked to carry detail it was never sized for.
* **Seen in pixels.** `shots/scale/crop-vista-blotches.png` (3× crop of the vista
  mid-ground) shows sharp-edged, axis-aligned squares of brighter radiance sitting on
  otherwise smooth terrain, all of roughly one size. That is the surfel footprint,
  rendered. On an unbroken grass slope there is nothing else it could be.
* **Cache vs albedo.** `shots/scale/crop-cachegi.png` is the raw resolve
  (`?split=gi`, albedo divided out): terrain reads bright sky-blue, instanced foliage
  and boulders read dark green. Foliage *is* receiving cached radiance, but far less
  than the terrain beside it. Orientation and albedo confound the comparison, so this is
  supporting evidence rather than proof — see "not measured" below.

This is the one of the five that does not need replacing. It needs a radius policy that
does not grow linearly to 30 m, and it needs a second, finer near-field source feeding
the resolve.

**What Lumen does with the equivalent.** Its world-space radiance cache clipmap is the
same idea and has the same property — probe density falls off with distance. The
difference is that Lumen never asks it to carry blade-scale detail: near-field indirect
comes from screen traces and the detail tracing pass, per-mesh radiance comes from the
surface cache, and the clipmap is the *far* term only. The structure here is right; what
is missing is everything that is supposed to sit in front of it.

---

## Frame cost

`requestAnimationFrame` is display-locked at 8.3 ms on this machine, so wall-clock frame
time is an **upper bound only** and does not discriminate between these scenes. It is
reported because it was asked for, and because it establishes that CLAUDE.md's ≥45 fps
target is met everywhere tested.

| | median | p95 | max | draws | GPU render | GPU compute |
|---|---|---|---|---|---|---|
| cornell | 8.4 ms | 9.2 ms | 13.4 ms | 27 | 0.18 ms | 3.20 ms |
| large (5,350 inst.) | 8.6 ms | 16.7 ms | 19.7 ms | 91 | 3.24 ms | 7.11 ms |
| large (40,150 inst.) | 9.2 ms | 12.3 ms | 14.0 ms | 91 | 3.37 ms | 6.16 ms |
| large (80,150 inst.) | 10.2 ms | 13.7 ms | 15.6 ms | 91 | 3.87 ms | 3.65 ms |

Note the last row. GPU **compute time falls** from 6.16 ms to 3.65 ms as the scene gets
denser — because at 80,150 instances the BVH budget has dropped 14 % of the scene and
the integrator has less to trace. Getting cheaper by silently holding less of the world
is the exact failure mode §1 describes, and it is invisible in a frame-time graph.

---

## What could not be measured, and what it would take

Each of these needs a change in a file owned by another agent this week. They are
written here rather than made.

1. **The pre-fix instancing run.** `sceneBvh.ts` already contained the instance
   expansion when this scene first booted, so the "before" state could only be derived
   from the census, not executed. To make the fix provable rather than argued, that file
   wants an ablation knob — `?bvhInstances=0` collapsing back to one copy per Mesh —
   the same way `?dyntrace=0` already exists for dynamic tracing.
   *Owner: `src/shared/gi/surfel/sceneBvh.ts`.*

2. **Legitimate access to the BVH stats.** `scaleProbe.ts` reaches through TypeScript
   `private` at runtime to read `gi.bvh`, because `SurfelGI` exposes no accessor. It
   works (TS `private` is compile-time only) but it will break silently the first time
   the field is renamed. A `get bvhStats(): { triangles, nodes, bytes }` would fix it.
   *Owner: `src/shared/gi/surfelGI.ts`.*

3. **Per-pass GPU timing.** `renderer.info` aggregates all compute into one number, so
   "the integrator costs X" cannot be separated from "the grid build costs Y". This
   needs `renderer.trackTimestamp` set explicitly plus per-pass query resolution.
   *Owner: `src/shared/render/renderer.ts`, `frameGraph.ts`.*

4. **Real resident GPU memory.** WebGPU exposes no per-buffer residency query, so the
   764 B/surfel figure is reconstructed from `ensureCapacity` term by term. If that
   function changes, `surfelPoolBytes()` in `scaleProbe.ts` silently goes stale.
   Exporting `BYTES_PER_SURFEL` from `surfelPool.ts` and asserting against it would make
   the measurement self-checking.
   *Owner: `src/shared/gi/surfel/surfelPool.ts`.*

5. **Whether instanced foliage is correctly lit by the cache.** The `?split=gi` capture
   shows foliage darker than adjacent terrain, but albedo and card orientation confound
   it. Settling it needs a surfel-coverage debug view (surfels per pixel, or surfel id)
   reachable from the URL. `surfel/debug/surfelScreenDebug.ts` has modes of roughly this
   shape already; none is wired to a query parameter.
   *Owner: `src/shared/gi/surfel/debug/surfelScreenDebug.ts`, `frameGraph.ts`.*

---

## Summary

| # | claim under test | cornell | large | verdict |
|---|---|---|---|---|
| 1 | one flat BVH, uploaded whole | 96 tris, 16.8 kB, 0.7 ms | 168 k tris, 28.2 MiB, 543 ms; caps at 500 k and drops meshes | **fails outright** |
| 2 | uniform-cell lightmap atlas | 0.063 m/texel | 1.634 m/texel; 28 m/texel for instances; 46 % of texels unseeded at 1024 | **fails outright** |
| 3 | 1024² diffuse layer per material | 3 layers, 12.0 MiB | 31 layers, 124.0 MiB, no mips, 16 duplicates | **degrades** |
| 4 | `MAX_SURFELS` allocated at boot | 382 MiB for 2.2 MiB used (1.18 %) | 382 MiB for 6.0 MiB used (3.14 %) | **degrades** (mis-sized both ways) |
| 5 | surfel hash-grid clipmap | ±409.6 m, 0.75 m surfels | ±409.6 m reach holds; 7.5 m surfels at 100 m, visibly blocky | **scales geometrically, degrades in fidelity** |

The order of work this implies: replace the flat BVH with a distance-field clipmap
(§1) and the lightmap with a screen-sized surface cache (§2), because those two fail
rather than bend. Then size the diffuse array and the surfel pool against what is on
screen (§3, §4). The hash grid (§5) is the only piece to keep as it stands, and it will
only start reading correctly once something finer sits in front of it.

## Screenshots

| file | what it shows |
|---|---|
| `shots/scale/large-vista.png` | wide vista, 400 m terrain, trees, instanced scatter |
| `shots/scale/large-closeup.png` | instanced alpha-cut ground cover at eye height, grounded |
| `shots/scale/crop-vista-blotches.png` | 3× crop: surfel-footprint squares on smooth terrain |
| `shots/scale/large-indirect.png` | `?giMode=indirect` — indirect term alone |
| `shots/scale/crop-cachegi.png` | 3× crop of `?split=gi` — raw cache radiance, albedo removed |
| `shots/scale/large-lightmap.png` | left: lightmap-lit beauty; right: the baked 512 atlas |

Raw JSON: `shots/scale/scale.json`, `sweep-terrain.json`, `sweep-instances.json`,
`sweep-lightmap.json`, `lm512-large.json`.
