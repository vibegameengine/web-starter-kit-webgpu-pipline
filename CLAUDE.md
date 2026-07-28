# CLAUDE.md — Elderwood AAA Forest Showcase

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
