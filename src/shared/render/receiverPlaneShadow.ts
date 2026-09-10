import * as THREE from 'three/webgpu';
import { Fn, Loop, dFdx, dFdy, float, vec2, vec3, textureLoad, reference } from 'three/tsl';

type ShadowInputs = {
  depthTexture: THREE.DepthTexture;
  shadowCoord: ReturnType<typeof vec3>;
  shadow: THREE.LightShadow;
};

/** Directional-light PCF with a separate receiver-plane depth at each texel.
 * See Microsoft, Cascaded Shadow Maps: per-texel depth bias with DDX/DDY.
 * The 4x4 separable weights reproduce a bilinearly translated 3x3 box. Raw depth
 * loads let every comparison use its own plane depth; hardware PCF would compare
 * four different texels against one depth and reintroduce slope-dependent acne.
 */
export function receiverPlaneShadowFilter({ depthTexture, shadowCoord, shadow }: ShadowInputs): THREE.Node {
  return Fn(() => {
    const coord = vec3(shadowCoord).toVar();
    const dx = dFdx(coord).toVar();
    const dy = dFdy(coord).toVar();
    const det = dx.x.mul(dy.y).sub(dx.y.mul(dy.x)).toVar();
    // Preserve orientation and keep edge-on/degenerate triangles finite.
    const divisor = det.abs().max(1e-12).mul(det.greaterThanEqual(0).select(1, -1));
    const gradient = vec2(
      dx.z.mul(dy.y).sub(dx.y.mul(dy.z)),
      dx.x.mul(dy.z).sub(dx.z.mul(dy.x)),
    ).div(divisor).toVar();
    const mapSize = reference('mapSize', 'vec2', shadow);
    const pixel = coord.xy.mul(mapSize).sub(.5).toVar();
    const base = pixel.floor().toVar();
    const f = pixel.fract().toVar();
    // The separable weights [1-f, 1, 1, f] as a function of the index rather than
    // sixteen written-out taps: unrolling this filter into the WGSL of every material
    // that receives the sun cost megabytes of generated shader and seconds of boot.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const edgeWeight = (index: any, frac: any) =>
      index.equal(0).select(frac.oneMinus(), index.equal(3).select(frac, float(1)));
    const sum = float(0).toVar();
    Loop(4, 4, ({ i, j }) => {
      const tap = base.add(vec2(float(j).sub(1), float(i).sub(1))).clamp(vec2(0), mapSize.sub(1)).toVar();
      const uv = tap.add(.5).div(mapSize);
      const receiverDepth = coord.z.add(gradient.dot(uv.sub(coord.xy)));
      const depth = textureLoad(depthTexture, tap, 0).r;
      const weight = edgeWeight(j, f.x).mul(edgeWeight(i, f.y));
      sum.addAssign(receiverDepth.lessThanEqual(depth).select(1, 0).mul(weight));
    });
    return sum.div(9);
  })();
}

/** Scoped to ordinary directional depth maps; point/cascade/array paths differ. */
export function installReceiverPlaneShadows(light: THREE.DirectionalLight): void {
  (light.shadow as THREE.DirectionalLightShadow & { filterNode: typeof receiverPlaneShadowFilter }).filterNode = receiverPlaneShadowFilter;
}
