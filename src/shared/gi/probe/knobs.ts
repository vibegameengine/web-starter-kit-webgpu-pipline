/**
 * URL knobs owned by the screen-probe tier.
 *
 * Read here rather than threaded through `app/main.ts`, for the reason `surfel/knobs.ts`
 * sets out at length: these are ablation switches whose only job is to make a claim in a
 * report reproducible by someone holding the URL and nothing else, and putting a
 * measurement harness's vocabulary into the composition root is the wrong trade. Every
 * default below is the shipping behaviour.
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

export const probeKnobs = {
  /**
   * `?probeReproj=0` puts the vertically mirrored history lookup back.
   *
   * Kept as a switch because it is the evidence: nothing about a still frame shows this
   * bug, and the only way to attribute the flicker to it rather than to sample noise or
   * to the trace stride is to be able to turn one line of arithmetic off and watch the
   * number move.
   */
  reprojectFlipY: () => flag('probeReproj', true),

  /**
   * `?dyndelta=0` puts lightmap mode back to placing probes on movers alone.
   *
   * That was the old behaviour and it is the thing the dynamic term replaces: a
   * lightmapped pixel got no probe, so it resolved to zero, so a mover could neither
   * tint it nor shadow it. Kept as a switch rather than deleted because it is the only
   * honest before-and-after — the probe tier is not in git history yet, and "the frame
   * is unchanged when nothing is moving" is a claim that needs two captures rather
   * than an argument about which branch cannot fire.
   */
  dynamicDelta: () => flag('dyndelta', true),

  /**
   * `?probeAge=1` turns the probe history from a flag into an accumulation count.
   *
   * The shipping blend is binary in two places at once: a texel's history is either
   * accepted whole or thrown away whole (`dot(pn,N) > 0.9 && offPlane < planeEps`),
   * and whatever survives is blended at a fixed alpha tuned on a *static* wall. On a
   * mover the plane test sits right on its own threshold — the demo sphere travels a
   * planeEpsilon or so per frame — so part of a probe passes and part fails, and the
   * part that fails takes a raw one-sample trace at full weight while its neighbour
   * takes a 6% correction. The gap between those two is the flicker.
   *
   * Off by default because it changes the meaning of a field the shipping path also
   * writes (`hist.w`), and the whole point of measuring it is to be able to put the
   * old arithmetic back with a URL rather than a rebuild.
   */
  temporalAge: () => flag('probeAge', false),

  /**
   * Ceiling on the accumulated-frame count, i.e. the longest window the running
   * average is allowed to become. Lumen's own screen probes cap at ten
   * (`r.Lumen.ScreenProbeGather.Temporal.MaxFramesAccumulated`) and the same number
   * lands here: the floor it puts under alpha is 1/11 ~ 0.09, a shade quicker than
   * the 0.06 the static wall was tuned to, which is the price of being able to
   * converge from a cold start in ten frames rather than thirty.
   */
  temporalAgeMax: () => num('probeAgeMax', 10),

  /** `?ao=0` is the ablation the short-range AO term is measured against. */
  // Off until it passes acceptance. The pass was left half-written — it
  // reconstructs a sample position from a continuous UV but a nearest-filtered
  // depth, which self-occludes flat surfaces — and an unaccepted feature that is
  // on by default puts its own artefacts into every capture taken to diagnose
  // something else. Turn it on with `?ao=1` to work on it.
  shortRangeAO: () => flag('ao', false),

  /**
   * World radius of the short trace, in metres.
   *
   * This is the number that decides whether the term is *contact* shading or just more
   * ambient occlusion. The probe pitch is 16px and the probe-space bilateral filter is
   * 5x5, so the tier above cannot resolve anything under roughly 80 screen pixels; at
   * the Cornell close-up pose one pixel is 0.75cm, so 80px is 60cm. A radius of 0.3
   * puts the whole term inside 40px — below what the probes can see, which is the only
   * reason for it to exist.
   */
  aoRadius: () => num('aoRadius', 0.3),

  /**
   * How hard the occlusion bites. The estimator returns roughly 0.5 for a point sitting
   * exactly in a right-angled corner (half the hemisphere blocked, and the horizon
   * falloff gives up the rest), so 2.0 is "a perfect corner goes black" and anything
   * above 1.5 starts to crush the junction rather than shade it.
   */
  aoIntensity: () => num('aoIntensity', 1.3),

  /**
   * Cosine below which a neighbour is treated as coplanar rather than occluding. Guards
   * self-occlusion from depth-buffer quantisation on a flat surface, which otherwise
   * shows up as a grey haze over everything.
   */
  aoBias: () => num('aoBias', 0.08),
};
