import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  cos,
  dFdx,
  dFdy,
  float,
  int,
  ivec2,
  reference,
  screenCoordinate,
  sin,
  tan,
  textureLoad,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { receiverPlaneShadowFilter } from './receiverPlaneShadow.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

type ShadowInputs = {
  depthTexture: THREE.DepthTexture;
  shadowCoord: ReturnType<typeof vec3>;
  shadow: THREE.LightShadow;
};

/**
 * Apparent diameter of the sun disc, degrees. 0.533° is the Earth value (0.524–0.542°
 * over the year); it is the one physical input to the penumbra width. A slider on it is
 * an *art* knob, not a correction.
 */
export const U_SUN_ANGULAR_DIAMETER_DEG = uniform(0.533);

/** Widest filter, in shadow-map texels: 16 texels at 4096 over 30 m is 12 cm of penumbra. */
const MAX_RADIUS_TEXELS = 16;
/** Blockers are looked for inside this radius; beyond it the penumbra is clamped anyway. */
const MAX_SEARCH_TEXELS = 16;
/** Below this radius the exact translated 3x3 box (receiverPlaneShadow) is the better filter. */
const HARD_RADIUS_TEXELS = 1.5;
/**
 * Slope the receiver-plane extrapolation is trusted up to: beyond ~70° the tangent plane
 * of a curved receiver leaves the surface within a few texels, and an unbounded
 * correction reintroduces the acne it was meant to remove.
 */
const MAX_PLANE_SLOPE = Math.tan(THREE.MathUtils.degToRad(70));

/**
 * Deterministic Poisson disc: dart throwing with a fixed LCG, points sorted by y so
 * neighbouring taps hit neighbouring cache lines (vsg-dev PCSS notes).
 */
function poissonDisc(count: number, seed: number): Array<[number, number]> {
  let state = seed >>> 0;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const points: Array<[number, number]> = [];
  const minDist = Math.sqrt(1 / count) * 0.9;
  let attempts = 0;
  while (points.length < count && attempts < 200000) {
    attempts++;
    const r = Math.sqrt(rand());
    const a = rand() * Math.PI * 2;
    const p: [number, number] = [r * Math.cos(a), r * Math.sin(a)];
    if (points.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) >= minDist)) points.push(p);
  }
  if (points.length < count) throw new Error(`poissonDisc: only ${points.length}/${count} points`);
  return points.sort((a, b) => a[1] - b[1]);
}

const SEARCH_TAPS = poissonDisc(16, 0x9e3779b9);
const FILTER_TAPS = poissonDisc(32, 0x85ebca6b);

/**
 * Percentage-closer soft shadows for the sun, built on the receiver-plane filter.
 *
 * The sun is a disc of angular diameter α (0.533°). A blocker at distance d in front of
 * a receiver casts a penumbra of width d·tan α on it — a frond 4.5 m up blurs its shadow
 * over ~4 cm, a pebble's shadow stays sharp at its base. For an orthographic shadow map
 * depth is linear, so distances come straight from the depth values: d = Δz·(far − near).
 *
 *  1. Blocker search: 16 Poisson taps inside the cone the receiver sees the sun through
 *     (radius d_receiver·tan(α/2), clamped); each tap compares against its *own*
 *     receiver-plane depth, so a sloped floor does not count itself as a blocker.
 *  2. Penumbra: filter radius = (z_receiver − mean blocker z)·(far − near)·tan α / 2 per
 *     texel, clamped to 16 texels.
 *  3. Filter: below 1.5 texels the exact translated 3x3 box of `receiverPlaneShadow.ts`
 *     (no noise, the fine-acne fix stays intact); above it 32 Poisson taps rotated per
 *     pixel by blue noise, each with its own plane-corrected depth. The plane correction
 *     is bounded by a 70° slope per texel of distance so curved receivers cannot pull
 *     acne back in at the wide end.
 *
 * Cost: 16 + 32x4 raw depth loads in penumbrae (bilinear taps), 16 + 16 in hard cores,
 * 16 where the search finds no blocker.
 *
 * References: Fernando 2005 (PCSS); NVIDIA GameWorks soft-shadow sample (gradient
 * depth bias scaled by uv distance); vsg-dev discussion #1107 (cache-ordered disc,
 * depth clamping squashing blockers — this map's near/far span the whole scene, so no
 * clamping happens); Bevy `shadow_sampling.wgsl` (the sun's angle as a constant).
 */
export function softSunShadowFilter({ depthTexture, shadowCoord, shadow }: ShadowInputs, blueNoise: THREE.Texture): THREE.Node {
  const camera = shadow.camera as THREE.OrthographicCamera;
  return Fn(() => {
    const coord = vec3(shadowCoord).toVar();
    const dx = dFdx(coord).toVar();
    const dy = dFdy(coord).toVar();
    const det = dx.x.mul(dy.y).sub(dx.y.mul(dy.x)).toVar();
    const divisor = det.abs().max(1e-12).mul(det.greaterThanEqual(0).select(1, -1));
    const gradient = vec2(
      dx.z.mul(dy.y).sub(dx.y.mul(dy.z)),
      dx.x.mul(dy.z).sub(dx.z.mul(dy.x)),
    ).div(divisor).toVar();

    const mapSize = reference('mapSize', 'vec2', shadow);
    const near = reference('near', 'float', camera);
    const far = reference('far', 'float', camera);
    const left = reference('left', 'float', camera);
    const right = reference('right', 'float', camera);
    const depthRange = far.sub(near);
    const texelWorld = right.sub(left).div(mapSize.x);
    const texelUv = float(1).div(mapSize.x);
    const tanSun = tan(U_SUN_ANGULAR_DIAMETER_DEG.mul(Math.PI / 180));
    // Per texel of offset, the largest plane correction still believed (depth units).
    const planeLimitPerTexel = texelWorld.mul(MAX_PLANE_SLOPE).div(depthRange);

    // Blue-noise rotation of both discs: stable per pixel, no structured banding.
    const noiseTexel = ivec2(screenCoordinate.xy).mod(int(128));
    const angle = textureLoad(blueNoise, noiseTexel, 0).r.mul(Math.PI * 2);
    const rot = vec2(cos(angle), sin(angle)).toVar();
    const rotate = (p: [number, number]) => vec2(
      rot.x.mul(p[0]).sub(rot.y.mul(p[1])),
      rot.y.mul(p[0]).add(rot.x.mul(p[1])),
    );
    const receiverAt = (offsetTexels: N, distanceTexels: number) => {
      const correction = gradient.dot(offsetTexels.mul(texelUv));
      const limit = planeLimitPerTexel.mul(distanceTexels);
      return coord.z.add(correction.clamp(limit.negate(), limit));
    };
    const load = (offsetTexels: N) => {
      const tap = coord.xy.mul(mapSize).sub(0.5).add(offsetTexels).round().clamp(vec2(0), mapSize.sub(1));
      return textureLoad(depthTexture, tap, 0).r;
    };

    // --- 1. blocker search -------------------------------------------------------
    const receiverDistance = coord.z.mul(depthRange);
    const searchRadius = receiverDistance.mul(tanSun.mul(0.5)).div(texelWorld).clamp(1, MAX_SEARCH_TEXELS).toVar();
    const blockerSum = float(0).toVar();
    const blockerCount = float(0).toVar();
    for (const p of SEARCH_TAPS) {
      const offset = rotate(p).mul(searchRadius);
      const dist = Math.hypot(p[0], p[1]) * MAX_SEARCH_TEXELS;
      const depth = load(offset);
      const blocked = depth.lessThan(receiverAt(offset, dist));
      blockerSum.addAssign(blocked.select(depth, float(0)));
      blockerCount.addAssign(blocked.select(float(1), float(0)));
    }

    const result = float(1).toVar();
    If(blockerCount.greaterThan(0), () => {
      // --- 2. penumbra width ---------------------------------------------------
      const blockerDistance = coord.z.sub(blockerSum.div(blockerCount)).max(0).mul(depthRange);
      const radius = blockerDistance.mul(tanSun).mul(0.5).div(texelWorld).clamp(0, MAX_RADIUS_TEXELS).toVar();

      If(radius.lessThan(HARD_RADIUS_TEXELS), () => {
        // --- 3a. hard core: the exact receiver-plane box ---------------------
        result.assign(receiverPlaneShadowFilter({ depthTexture, shadowCoord, shadow }));
      }).Else(() => {
        // --- 3b. penumbra: rotated Poisson disc, plane-corrected per tap -----
        // Each tap is a bilinear 2x2 comparison (four loads, weights from the
        // fractional texel position) rather than one nearest compare: a tap then
        // returns a fraction, not a bit, and the disc's residual grain drops by
        // roughly the same factor as the texel footprint the tap covers.
        const lit = float(0).toVar();
        for (const p of FILTER_TAPS) {
          const offset = rotate(p).mul(radius);
          const dist = Math.hypot(p[0], p[1]) * MAX_RADIUS_TEXELS;
          const pixel = coord.xy.mul(mapSize).sub(0.5).add(offset);
          const base = pixel.floor();
          const f = pixel.fract();
          const wx = [f.x.oneMinus(), f.x];
          const wy = [f.y.oneMinus(), f.y];
          for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
            const cornerOffset = offset.add(vec2(x, y).sub(f));
            const tap = base.add(vec2(x, y)).clamp(vec2(0), mapSize.sub(1));
            const depth = textureLoad(depthTexture, tap, 0).r;
            const weight = wx[x].mul(wy[y]);
            lit.addAssign(receiverAt(cornerOffset, dist + 1).lessThanEqual(depth).select(weight, float(0)));
          }
        }
        result.assign(lit.div(FILTER_TAPS.length));
      });
    });
    return result;
  })();
}

/**
 * Installs the soft filter on an ordinary directional sun. The blue-noise texture is
 * the GI's 128x128 LDR tile (nearest, repeat).
 */
export function installSoftSunShadows(light: THREE.DirectionalLight, blueNoise: THREE.Texture): void {
  (light.shadow as THREE.DirectionalLightShadow & { filterNode: (inputs: ShadowInputs) => THREE.Node }).filterNode =
    (inputs) => softSunShadowFilter(inputs, blueNoise);
}
