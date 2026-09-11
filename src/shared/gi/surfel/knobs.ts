/**
 * URL knobs owned by the surfel GI modules.
 *
 * These are read here rather than wired through `app/main.ts` on purpose. Every other
 * switch in this build is a parameter threaded from the composition root, and that is
 * the right shape for anything the app has an opinion about — but these are ablation
 * and sizing switches whose only job is to make a claim in a report reproducible by
 * someone who has the URL and nothing else. Threading them through main.ts would put
 * a measurement harness's vocabulary into the composition root, and `largeScene.ts`
 * already established the precedent of a module reading its own scene knobs.
 *
 * Every one of them has a default that is the shipping behaviour. Nothing here changes
 * what the app does unless it is asked to.
 */

function params(): URLSearchParams | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search);
}

function num(name: string, fallback: number): number {
  const raw = params()?.get(name);
  if (raw === null || raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function flag(name: string, fallback: boolean): boolean {
  const raw = params()?.get(name);
  if (raw === null || raw === undefined || raw === '') return fallback;
  return raw !== '0' && raw !== 'off' && raw !== 'false';
}

export const giKnobs = {
  /**
   * `?bvhInstances=0` collapses an InstancedMesh back to one copy at its own origin,
   * which is what `sceneBvh.ts` did before the instance expansion landed.
   *
   * This exists because docs/scale-report.md had to *derive* the cost of that bug from
   * a census rather than run it — the fix was already in the working copy when the
   * large scene first booted, so there was no binary that exhibited it. An ablation is
   * the difference between a measurement and an argument.
   */
  bvhInstances: () => flag('bvhInstances', true),

  /**
   * Radius in metres around the BVH focus point inside which full triangles are kept.
   * Beyond it, geometry is clustered into proxy boxes. `0` (the default) means the
   * whole world stays at full detail, which is what every capture in the report so far
   * was taken with.
   */
  bvhFarRadius: () => num('bvhFar', 0),

  /** Triangle budget override, so budget behaviour can be exercised on a small scene. */
  bvhBudget: () => num('bvhBudget', 0),

  /* @important Weight below which a reused surfel was handed over without a visibility test. The
     weights are normalised afterwards, so a single untested donor at 0.01 carrying 50 becomes the
     whole answer: the threshold bounded nothing. `?donorGate=0.02` restores it as the ablation.
     Design section 04, source fragment C1. */
  donorVisibilityGate: () => num('donorGate', 0),

  /* @important The bake traces the segment from a hit to each surfel it reuses, instead of trusting
     the radial-depth moments. Two surfaces sharing a hash cell are what the moments cannot separate,
     and the weights are normalised afterwards. `?bakeExactReuse=0` is the ablation. Design section 04. */
  exactBakeReuse: () => flag('bakeExactReuse', false),

  /** @important `?spawnEps=radius` restores the ray offset that was a length in metres; see spawnEpsilon. */
  spawnEpsilonFromRadius: () => (params()?.get('spawnEps') ?? '') === 'radius',

  /* @important How far a bake sample may move toward the neighbours it can see, as a fraction of
     their spacing. Off by default and not because it is wrong: the case it was built for - the
     sealed room at 0.23 m/texel, where a texel spans the wall base - now reads 0.00001 with it at 0,
     the ray distance epsilon having been the whole leak. Moving every edge sample shifts contact
     shadows, and nothing measured pays for that yet. `?bakePlacement=0.35` turns it on. Section 02. */
  bakePlacement: () => num('bakePlacement', 0),

  /** @important `?bakeHidden=1` marks texels whose centre a parity ray calls inside a closed body; see filterLinks. */
  bakeHiddenTexels: () => flag('bakeHidden', false),

  /** Base surfel pool capacity, before any growth. */
  surfelBase: () => num('surfels', 0),

  /** Texels-per-metre scale for ray-cone mip selection in the integrator. */
  diffuseLodScale: () => num('giLod', 1.0),

  /** Per-layer edge cap for the diffuse array. */
  diffuseLayerCap: () => num('diffuse', 0),

  /**
   * `?geoseed=0` puts the bake back on the orbit-camera sweep it used to use.
   *
   * The whole claim behind geometry-driven seeding is that a camera cannot see into a
   * concave corner and therefore leaves a hole in the cache that only closes by
   * spending more views. That is a claim about two builds, so both have to be runnable.
   */
  // Default OFF: as it stands it makes the thing it was written to fix strictly worse.
  //
  // The per-configuration wall readings that used to be cited here were single captures
  // taken while the bake still ran the wall-clock sweep, and under that sweep half the
  // grid sat in cells the resolve could only read an arbitrary subset of — the same
  // region flickered between 6 and 75 frame to frame. A signal of ~50 units against a
  // spread of ~80 is not evidence, so those numbers are gone.
  //
  // The conclusion survives, on three runs per configuration rather than one. `geoseed=0`
  // wedges read 88.3/70.7/87.1 and 106.7/110.6/134.4; `geoseed=1` reads exactly 0.0 in
  // five of the six samples. Nothing that repeats at 0.0 is a convergence shortfall.
  //
  // The mechanism is now measured rather than guessed, and it is density, not eviction.
  // `?gridstats=` on the Cornell box: the orbit sweep leaves 41,809 entries in the hash
  // grid with 241 cells over the resolve's fetch cap; geoseed leaves 61,465 entries with
  // 437 cells over it — 78.3 % of the grid, against 51.7 %. Area-sampling the triangles
  // places surfels denser than the grid can be read back at, so the corners it was
  // written to cover are precisely the cells that come back empty-handed.
  //
  // Turn it on with `?geoseed=1` to work on it. The idea is still right — a camera cannot
  // see into a concave corner — but the placement has to respect the fetch cap.
  geometrySeed: () => flag('geoseed', false),

  /** Surfel budget the geometry sampler solves its spacing against. */
  geometrySeedBudget: () => num('geoseedBudget', 0),

  /**
   * `?holefill=0` puts the bake back on the orbit sweep alone.
   *
   * Not the same switch as `geoseed`, and deliberately a separate one. `geoseed`
   * *replaces* find-missing with geometry placement; this *supplements* it, spawning
   * only where find-missing's own three gates say a pixel would have spawned had a
   * pixel ever landed there. So the two ablations answer different questions and both
   * have to stay runnable — the geoseed regression was caught precisely because the
   * before and after were one flag apart, and a fix for it that folded into the same
   * flag would have thrown that away.
   *
   * See bake/holeFill.ts for the measurement this defaults on for.
   */
  holeFill: () => flag('holefill', false),

  /**
   * Coverage below which the fill considers a point uncovered. Defaults to
   * find-missing's own spawn threshold; a different number here would mean the two
   * passes disagree about what a hole is, which is the whole thing this avoids.
   */
  holeFillCoverage: () => num('holefillW', 0.1),

  /**
   * Fraction of the candidate list the fill tests per dispatch.
   *
   * `?holefillRate=1` tests all of them at once, which is the build that failed: the
   * hash grid is a frame old to every candidate in a dispatch, so none of them can see
   * what the others are placing, and the Cornell box took 2,885 surfels where a few
   * hundred were wanted.
   */
  holeFillRate: () => num('holefillRate', 0.1),

  /**
   * Coverage a neighbouring point must have before an empty one counts as a hole.
   *
   * `?holefillEdge=0` drops the adjacency test and turns this back into "spawn on every
   * surface no camera saw", which includes the outward faces of every wall.
   */
  holeFillEdge: () => num('holefillEdge', 0.5),

  /** Candidate budget the fill's geometry sampler solves its spacing against. */
  holeFillBudget: () => num('holefillBudget', 0),

  /**
   * `?bakeclock=1` puts the bake back on the wall-clock budget it used to run on.
   *
   * The ablation the determinism claim is measured against, and the reason it exists is
   * that the old budget made the *population* a function of how long you waited. Each
   * orbit view spawns wherever the last one lacked coverage, nothing ever stops, and the
   * immortaliser pins whatever is alive when the clock runs out: 23 views put 10,144
   * entries in the hash grid, 618 views put 41,809 in the same 971 cells. The cache is
   * not four times better, it is four times denser — and past a certain density the
   * renderer stops being able to read it, because `surfelGIResolvePass` fetches at most
   * `RESOLVE_FETCH_CAP` surfels out of a cell in whatever order the grid's atomics
   * retired. At 618 views, 51.7 % of the grid sat in cells over that cap.
   *
   * That is what made a bake look non-deterministic. It was not: the cache repeated to
   * ~1 % run to run. The *frame* did not, because half of it was an arbitrary subset
   * redrawn every frame — the same capture flickered between 6 and 75 on a wedge region
   * with the whole lifecycle frozen and the cache byte-identical.
   */
  deterministicBake: () => !flag('bakeclock', false),

  /**
   * Orbit views the bake spends spawning before it stops growing the population.
   *
   * Small on purpose, and 48 is where the two costs cross. 23 views already reach 922 of
   * the 971 hash-grid cells 618 views reach, so coverage is bought early and everything
   * after it is redundancy — measured on the Cornell box, 16/32/48/64/128/618 spawn views
   * leave 29/51/77/113/162/241 cells over the resolve's fetch cap. Density does still buy
   * some multi-bounce energy, which is why this is not 16.
   */
  bakeSpawnViews: () => num('bakespawn', 48),

  /**
   * Integrations run after spawning stops, with the population held fixed.
   *
   * Far above `MAX_TEMPORAL_M`, and that is not an oversight. MSME saturates there, but
   * the estimate does not: each integration's multi-bounce lookup reads neighbours that
   * the previous one brightened, so energy walks through the cache one bounce per pass
   * and the whole thing is still climbing long after any single surfel has stopped
   * accumulating. On the Cornell box the wall control reads 141.6 at 200 passes, 145.1 at
   * 400, 147.3 at 800 and 148.5 here — against 151.9 for the old six-second sweep, which
   * bought the last few units with four times the surfels rather than with convergence.
   *
   * These are integrations and not views, so none of them spawns anything: the population
   * is identical at 200 and at 800 (51 versus 52 cells over the fetch cap). That is the
   * whole reason the two phases are separate — convergence is now free of density.
   */
  bakeIntegrations: () => num('bakeiters', 800),

  /**
   * `?resolvecap=1` puts the resolve back on the first-64-entries-in-the-cell subset.
   *
   * The ablation the per-frame determinism claim is measured against. That subset was
   * never chosen — the grid's slot pass writes each cell's list with `atomicAdd(-1)`, so
   * a cell holding more than 64 hands the resolve whatever 64 the GPU's atomics happened
   * to retire that frame. With the entire lifecycle frozen and the cache byte-identical,
   * the same wedge region sampled every 150 ms inside one run still swung across tens of
   * units, because a subset can arrive whose members all weight to zero through
   * `max(0, dot(sNor, pixNormal))` and a subset can arrive that does not.
   *
   * The default sums the cell instead of sampling it, which is deterministic because
   * addition does not care what order the atomics retired in. Left switchable because a
   * measurement that cannot be run against the build it replaced is an assertion.
   */
  deterministicResolve: () => !flag('resolvecap', false),

  /**
   * `?gridstats=N` reads the hash grid back at frame N and logs how many surfels each
   * occupied cell holds.
   *
   * A diagnostic rather than a feature, and it stays because the question it answers is
   * the one that keeps being answered wrongly. `surfelGIResolvePass` fetches at most
   * `maxFetchPerPixel` surfels out of the cell a pixel hashes into, and the grid fills
   * each cell in whatever order the GPU's atomics happened to retire, so a cell holding
   * more than that many hands the resolve a *different subset every frame*. Nothing about
   * that shows up in a surfel census — the cache is identical — and it is invisible in a
   * single screenshot. It needs the occupancy number.
   */
  gridStatsAt: () => num('gridstats', 0),

  /**
   * Lights each ray samples when the scene has more than this many. Below it every
   * light is evaluated exactly; see the note in sceneLights.ts on why that boundary
   * exists at all.
   */
  lightSamples: () => num('lightSamples', 2),

  /**
   * `?lights=0` removes every point and spot light from the GI light buffer while
   * leaving them in the scene and in the raster. The ablation the multi-light claim is
   * measured against: nothing else about the frame changes, including which surfaces
   * are directly lit on screen.
   */
  analyticLights: () => flag('lights', true),

  /** `?emissive=0` stops emissive materials injecting radiance, same ablation shape. */
  emissiveLights: () => flag('emissive', true),

  /**
   * `?dynsurfel=1` keeps the surfel lifecycle running for movable geometry after a
   * lightmap bake, instead of freezing the entire pool.
   *
   * The default freezes everything, and that is a measurable defect rather than a
   * conservative choice. A lightmap bake spends the whole pool on atlas texels, and the
   * atlas is by construction the *static* half — so a `Mobility.Movable` mesh ends up
   * with no surfel anywhere on it, and its indirect light comes entirely from the screen
   * probes, which trace one or two rays per texel per frame. The surfel accumulator that
   * normally hides that noise (MSME, up to `MAX_TEMPORAL_M` moments) is switched off with
   * the rest of the lifecycle. Measured on the moving ball with `scripts/_flicker.mjs`,
   * mean frame-to-frame over six frames: 3.83 / 4.03 frozen, against 2.14 for the live
   * surfel+probe path and 1.87 for surfels alone. The measurement floor on that region is
   * 0.20, so the frozen build is running at roughly twice the noise of either.
   *
   * On, the atlas surfels are pinned by the immortaliser the moment the bake finishes —
   * exactly what `bake()` already does to its own cache — and the freeze is declined. A
   * pinned surfel is skipped by the age pass and by the integrator, and is never returned
   * to the free list, so the atlas occupies stack slots `[0, seeded)` permanently and the
   * runtime allocator can only ever hand out the tail. That is the reserved-tail-segment
   * split, obtained from state the pool already has rather than from a second free list.
   *
   * Off by default because it is new, and because the thing it changes — whether the
   * lifecycle runs at all in lightmap mode — is not something a report should have to
   * guess at from a build date.
   */
  dynamicSurfels: () => flag('dynsurfel', false),
  // @important `?dynamicGi=0` stops the screen resolve reading surfels on rigid receiver pixels, so a mover keeps its direct light and shadow and loses only its surfel indirect. It answers "is a surfel worth its cost on dynamics" by picture. Cornell only: the beach reports movers 0, its ball being giExclude, so nothing there is dynamic to the GI.
  dynamicGi: () => flag('dynamicGi', true),
  // @important `?unboundGi=0` stops the screen resolve reading surfels on unbound receivers - everything the unwrap refused a chart, which on the beach is the palm and shrub leaves, the shrub stems and the island's underside, and anywhere else an InstancedMesh. That set is static, its light never changes, and it is the only thing the live chain serves on the beach (movers 0). Turning it off shows what the live half is actually paying for there.
  unboundGi: () => flag('unboundGi', true),
  /* @important `?giScale=` sizes the GI G-buffer, and with it the find-missing and resolve passes,
     as a fraction of the screen. They run per screen pixel, which is why the whole unbaked receiver
     class costs 3.6 ms at 720p and 48 ms of a 63 ms frame at 4K (2026-09-10, scripts/_4k_budget.mjs).
     1 is the shipping resolution; the frame is not yet judged at anything less. */
  giScale: () => Math.min(1, Math.max(0.25, num('giScale', 1))),
};
