# Render pipeline = **webgiya**

## The point

The correct GI / frame graph is **[jure/webgiya](https://github.com/jure/webgiya)** (vendored at `vendor/webgiya`).

It is **not**:
- hashBlur “SSGI-lite”
- random god-ray noise soup
- one-off Pipeline2 experiments in `src/shared/engine2`

Those were wrong direction.

## What webgiya is

Surfel-based real-time GI on WebGPU + Three.js TSL:

```
GBuffer → Surfel prepare/find/allocate/age
       → Hash grid (cascaded)
       → Integrate (BVH RT per surfel + guiding + MSME)
       → Radial depth (leak control)
       → Resolve (per-pixel GI)
       → Composite (direct + indirect) + FXAA
```

Plus Three **Inspector** for debug (the tool you meant).

## Run

```bash
npm install
npm run dev          # http://127.0.0.1:5188  → vendor/webgiya
```

Scenes: Cornell, Sponza, Leonardo, occlusion tests, etc. (`?scene=cornell-box`).

Legacy muddy sandbox (if needed):

```bash
npm run dev:legacy   # port 5190, old src/app
```

## Sources

- https://github.com/jure/webgiya  
- https://juretriglav.si/surfel-based-global-illumination-on-the-web/  
- EA SEED GIBS / Kajiya (documented in webgiya README)
