import { Fn, float, vec2, vec3, vec4, uv, Loop, int, smoothstep, length, max, clamp } from 'three/tsl';

/**
 * Crepuscular rays (GPU Gems 3 Ch.13 style): radial occlusion blur toward the sun
 * in screen space, then additive combine. Works with depth (far = sky) OR
 * luminance of beauty as the shaft seed.
 */
export const godRays = /*@__PURE__*/ Fn(
  ([
    colorNode,
    depthNode,
    sunScreen = vec2(0.5, 0.35),
    intensity = float(0.55),
    decay = float(0.96),
    weight = float(0.35),
    density = float(0.85),
  ]: any[]) => {
    const texColor = colorNode;
    const texDepth = depthNode;

    const coord = uv().toVar();
    const delta = sunScreen.sub(coord).mul(density.div(48.0)).toVar();
    const illum = float(0.0).toVar();
    const fall = float(1.0).toVar();

    Loop(int(48), () => {
      coord.addAssign(delta);
      // sky / open hole: depth near far plane, plus bright pixels (sun disc / bloom core)
      const d = texDepth.sample(coord).r;
      const sky = smoothstep(0.992, 1.0, d);
      const lum = texColor.sample(coord).rgb;
      const bright = smoothstep(0.85, 1.8, lum.r.mul(0.3).add(lum.g.mul(0.5)).add(lum.b.mul(0.2)));
      const sample = max(sky, bright);
      illum.addAssign(sample.mul(fall).mul(weight));
      fall.mulAssign(decay);
    });

    // warm shaft tint (sunlight through dust)
    const shaft = vec3(1.0, 0.92, 0.75).mul(illum).mul(intensity);
    // fade when sun is far off-screen
    const sunDist = length(uv().sub(sunScreen));
    const edge = float(1.0).sub(smoothstep(0.9, 1.4, sunDist));
    return vec4(texColor.sample(uv()).rgb.add(shaft.mul(edge)), 1.0);
  },
);

/** Project world sun direction to UV in [0,1], z>0 if in front of camera. */
export function sunToScreen(
  sunDir: { x: number; y: number; z: number },
  camera: {
    matrixWorldInverse: { elements: number[] };
    projectionMatrix: { elements: number[] };
  },
  out: { x: number; y: number; z: number },
): boolean {
  // direction toward sun from camera → clip
  const e = camera.matrixWorldInverse.elements;
  // transform direction (w=0)
  const vx = sunDir.x * e[0] + sunDir.y * e[4] + sunDir.z * e[8];
  const vy = sunDir.x * e[1] + sunDir.y * e[5] + sunDir.z * e[9];
  const vz = sunDir.x * e[2] + sunDir.y * e[6] + sunDir.z * e[10];
  const p = camera.projectionMatrix.elements;
  const cx = vx * p[0] + vy * p[4] + vz * p[8] + p[12];
  const cy = vx * p[1] + vy * p[5] + vz * p[9] + p[13];
  const cw = vx * p[3] + vy * p[7] + vz * p[11] + p[15];
  if (Math.abs(cw) < 1e-5) {
    out.x = 0.5;
    out.y = 0.5;
    out.z = -1;
    return false;
  }
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  out.x = ndcX * 0.5 + 0.5;
  out.y = ndcY * 0.5 + 0.5;
  out.z = vz;
  return vz < 0; // three.js camera looks down -Z in view space
}
