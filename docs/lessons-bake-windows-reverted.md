# Windowed bake, reverted (2026-09-17)

Commits 7abc909 and 3d10879 baked the lightmap in 512² windows over the atlas with a bounce
cache, to make a 60 m ground plate fit. They were reverted the same day.

What they did to every scene, not only the large one:

- One bake became one bake per window: its own rasterisation, filter links, integration and
  readback. The atlas had been integrated in one pass over every texel at once.
- A bounce-cache pass was added in front of the bake.
- To remove the blotches that fifteen seconds split over four windows left, every window was
  given 200 passes and no time limit, which is the recipe the session had just removed.
- An uncommitted follow-up seeded up to ~100k context surfels per window and integrated them
  from scratch in every window; village-light went back to baking for minutes.

The rule it broke is the one this session was about: the startup is one bake or one read from
disk, then the BVH, then the frame. A large world must not be paid for by the startup of every
scene. Each step answered the last complaint (a chart too wide, blotches, a cache that thinned
out on a large world) and none was measured on village-light before the next one was built.

Kept: the lattice phase fix idea (a window origin inside a chart must not read as "no chart"),
and the lod-scale stand. The large-world bake is open again.
