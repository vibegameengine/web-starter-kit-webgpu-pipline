import { Fn, vec2, float, texture, reference, renderGroup } from 'three/tsl';

/**
 * Deterministic Gaussian PCF shadow filter (TSL), 7×7 taps.
 *
 * WHY this shape: every tap goes through the hardware depth-compare sampler
 * (bilinear), and the kernel is a fixed Gaussian — no random rotation. That
 * gives a wide, perfectly smooth penumbra with ZERO stochastic grain and,
 * because the footprint always spans several texels, ZERO staircase. No
 * temporal pass needed, so it looks identical on WebGPU and the WebGL
 * fallback. shadow.radius scales the kernel spacing (world softness).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const GaussianShadowFilter = /*@__PURE__*/ Fn((inputs: any) => {
  const { depthTexture, shadowCoord, shadow, depthLayer } = inputs;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const depthCompare = (uv: any, compare: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let depth: any = texture(depthTexture, uv);
    if (depthTexture.isArrayTexture) depth = depth.depth(depthLayer);
    return depth.compare(compare);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapSize = (reference('mapSize', 'vec2', shadow) as any).setGroup(renderGroup);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const radius = (reference('radius', 'float', shadow) as any).setGroup(renderGroup);
  const texel = vec2(1).div(mapSize).mul(radius);

  // 7-wide Gaussian (Pascal row 6): 1 6 15 20 15 6 1, sum 64 → /4096 for 2D
  const G = [1, 6, 15, 20, 15, 6, 1];
  const OFF = [-3, -2, -1, 0, 1, 2, 3];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sum: any = null;
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const w = (G[x] * G[y]) / 4096;
      const uv = shadowCoord.xy.add(vec2(OFF[x], OFF[y]).mul(texel));
      const tap = depthCompare(uv, shadowCoord.z).mul(float(w));
      sum = sum === null ? tap : sum.add(tap);
    }
  }
  return sum;
});
