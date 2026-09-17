# The bake no longer holds the world at once (2026-09-17)

The lightmap bake was the realtime surfel GI pointed at the atlas instead of the screen: one
surfel per lattice point of the whole atlas in one 262144-slot pool, one camera-centred grid,
one render target the size of the page stack, pages of 512. Every scene larger than "one view"
hit one of those walls, and a 40 m ground plate at 0.05 m/texel (808 texels) was refused
outright; the mustang scene's author shrank the ground to 24 m to get a bake.

What changed, in the manner of GPULightmass (read for the idea, nothing copied):

- **Bounce cache of a fixed size.** `SurfelGI.bakeBounceCache` spreads `?bounceCache=` (65536)
  surfels over every static surface, integrates them, pins them and snapshots them. A larger
  world gets them further apart, never more of them.
- **The atlas is baked in windows.** `StaticLight.bakeAtlas` walks the page stack in 512²
  windows with a 32-texel apron. Each window restores the cache, rasterises only its own
  rectangle (`rasteriseLightmapGBuffer(..., window)`), seeds its own texels, integrates,
  denoises, and pastes its inside into the CPU atlas. The GPU holds one window and the cache.
- **The page grows to the world.** `lightmapUv.ts` makes the page the power of two that holds
  the widest chart and doubles it while the stack does not fit 8192 rows, up to 4096.
  `safeMip` is a constant (2) instead of being derived from the page size.

## Frames (headed Chrome, baked-only)

- `?scene=lod-scale&ground=60`: 2048² page, 16 windows, cache 53195 surfels, the whole plate
  lit, the glow stripes baked, no seam visible between windows on the overview.
- `?scene=village-light`: against the single bake it replaced, 3359 of 921600 pixels differ
  by more than 16/255 and the mean green channel is 64.09 against 63.88: the same light.

## Trap

- **A negative chart origin was the "no chart" sentinel.** A window that starts inside a large
  chart puts the chart's corner left of or above the window; the seeder read the negative
  corner as "no chart" and seeded one fallback surfel for the whole plate, 28455 texels'
  worth. The seeder only needs the lattice phase, so the stored origin is `origin mod stride`.

## Open

- Each window re-uploads the whole cache to the pool from the CPU snapshot.
- The static BVH is still one tree with a triangle budget; past it, geometry becomes proxy
  boxes and bakes black.
- The CPU atlas is still one `Float32Array` of the whole stack before it is cut into tiles.
- `?leak=1` no longer records the denoise stages per window, only the blit and the padding.
