/**
 * URL knobs owned by the reflection tier.
 *
 * Read here rather than threaded through `app/main.ts`, for the reason `surfel/knobs.ts`
 * sets out: these are ablation and sizing switches whose job is to make a claim in a
 * report reproducible from a URL. Every default is the shipping behaviour.
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

export const reflectKnobs = {
  /** `?refl=0` is the ablation: the chain does not dispatch and nothing is composited. */
  // Off until it passes acceptance. Nothing in this pass has been demonstrated
  // with a number or a picture yet, and a default-on feature that has not been
  // accepted contaminates every capture taken for another reason. `?refl=1`.
  enabled: () => flag('refl', false),

  /**
   * `?reflScene=1` adds a chrome sphere and a mirror plate to the Cornell box.
   *
   * The reference scene has no glossy material at all, which is exactly why this gap
   * survived unnoticed — a reflection pass over a scene of roughness-1 walls renders
   * nothing and can neither be seen nor disproved. It is a URL variant rather than a
   * change to the default scene because every acceptance baseline in this build was
   * taken against the default scene, and a scene edit would invalidate all of them.
   */
  testScene: () => flag('reflScene', false),

  /** Roughness of the injected test surfaces. */
  testRoughness: () => num('reflGloss', 0.06),

  /**
   * Above this roughness a pixel does not trace at all.
   *
   * This is an honest statement of what one ray per pixel can carry, not a taste
   * setting. A GGX lobe at roughness 0.3 is already wide enough that a 3x3 spatial
   * filter and a 0.1 temporal blend leave visible blotching — measured, on the demo
   * mover, which is exactly roughness 0.3; `?reflRough=0.45` reproduces it. Below 0.25
   * the lobe is narrow enough that neighbouring pixels genuinely agree and the filter
   * has something to average.
   *
   * The number also has a second job. The default Cornell scene contains precisely one
   * material under 1.0 — that same mover — so a cutoff above 0.3 would silently switch
   * this whole tier on for every existing acceptance baseline in the build. 0.25 leaves
   * the shipping scene bit-identical and makes the tier opt-in through geometry that
   * actually wants it.
   */
  roughnessCutoff: () => num('reflRough', 0.25),

  /**
   * Ray budget in metres, beyond which a hit is shaded from the world-space cache
   * instead of being lit properly. 8 covers the whole Cornell box, so every reflection
   * measured on this scene is a full shade and the cheap tier is exercised only by
   * `?reflRange=`.
   */
  range: () => num('reflRange', 8),

  /** Blend weight for this frame's single ray against the reprojected history. */
  temporalAlpha: () => num('reflBlend', 0.1),

  /** `?reflFilter=0` drops the spatial pass, leaving the raw 1-spp temporal result. */
  spatialFilter: () => flag('reflFilter', true),

  /**
   * Screen divisor for the trace. 2 is Lumen's own choice and this build's: a BVH ray
   * per screen pixel costs more than the entire probe tier, and a specular lobe this
   * narrow survives the upsample far better than a diffuse one would.
   */
  resolutionDivisor: () => Math.max(1, Math.round(num('reflRes', 2))),

  /**
   * `?reflKd=0` stops this pass suppressing the diffuse term under a metal.
   *
   * Shipping behaviour is 1 and is not in doubt — a metal has no diffuse lobe, and the
   * composite has no material knowledge of its own to work that out with. The switch
   * exists because it is the only way to measure the reflection *on its own*: with it on,
   * `?refl=1` against `?refl=0` moves two things at once, a specular term appearing and a
   * diffuse term vanishing, and the difference image cannot be attributed to either. With
   * it off the two frames differ by exactly the additive term, so a red reflection moves
   * red and moves nothing else.
   */
  killMetalDiffuse: () => flag('reflKd', true),

  /**
   * `?reflDbg=N` replaces the traced radiance with one of its own factors.
   *
   * A dark patch in a reflection has four unrelated causes — the ray missed, the hit
   * shaded to nothing, the BRDF weight collapsed, or the G-Buffer handed the trace a
   * black F0 — and the composited frame looks identical under all four. These modes
   * exist because that question came up on the first capture of this pass and could not
   * be answered by staring at it. Pair with `?reflFilter=0&reflBlend=1` so what is on
   * screen is one frame's raw value rather than a filtered average of one.
   *
   *   1 incoming radiance before the BRDF weight   4 G-Buffer albedo as the trace sees it
   *   2 the BRDF weight alone (F x G2/G1)          5 hit/miss, white on hit
   *   3 F0, i.e. what metalness made of the albedo
   */
  debugMode: () => Math.max(0, Math.round(num('reflDbg', 0))),
};
