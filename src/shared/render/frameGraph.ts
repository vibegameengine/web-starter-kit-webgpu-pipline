import * as THREE from 'three/webgpu';
import {
  add,
  diffuseColor,
  mrt,
  normalView,
  output,
  pass,
  uniform,
  vec4,
  velocity,
} from 'three/tsl';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';

/**
 * TSL's fluent API returns a different concrete node class per operator, so the
 * chain is typed against the shared surface rather than any one of them.
 */
type TslNode = THREE.Node;

export interface SsgiParams {
  sliceCount: number;
  stepCount: number;
  aoIntensity: number;
  giIntensity: number;
  expFactor: number;
  thickness: number;
  backfaceLighting: number;
}

export const DEFAULT_SSGI: SsgiParams = {
  sliceCount: 2,
  stepCount: 8,
  aoIntensity: 1,
  giIntensity: 10,
  expFactor: 2,
  thickness: 1,
  backfaceLighting: 0,
};

/**
 * Elderwood Frame Graph — Phase 0 skeleton.
 *
 * What exists now:
 *   scene pass → MRT(HDR colour | albedo | view normal | velocity | depth)
 *              → SSGI (screen traces, returns vec4(GI.rgb, AO.a))
 *              → composite
 *              → TRAA
 *
 * What plugs in later, at the marked slots:
 *   Phase 1  cached static/dynamic cascade shadows (feeds the base pass)
 *   Phase 2  irradiance volume sample (adds to `indirect`)
 *   Phase 4  sky LUT + aerial perspective + froxel fog (between composite and TRAA)
 *   Phase 5  bloom / grade / grain (after TRAA)
 *
 * The ordering is not arbitrary — it is the UE ordering from
 * docs/ue-pipeline-study-and-plan.md §3.4, and screen traces come *first* because
 * that is what Lumen does: trace the screen, fall back to the world cache only for
 * what the screen cannot see.
 */
export class FrameGraph {
  readonly post: THREE.PostProcessing;
  readonly scenePass: ReturnType<typeof pass>;
  readonly ssgiParams: SsgiParams = { ...DEFAULT_SSGI };

  private readonly ssgiNode: ReturnType<typeof ssgi>;
  private readonly taps: Array<{ name: string; node: TslNode }> = [];

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    /**
     * Composite SSGI on top of the traced cache. Off by default — screen traces are
     * a refinement, never the GI itself.
     */
    private readonly useScreenTraces = false,
    private readonly debugTaps = true,
  ) {
    this.post = new THREE.PostProcessing(renderer);

    // ---- 3. Opaque base pass → G-Buffer -------------------------------------
    // r182 has no packNormalToRGB; PassNode allocates HalfFloat targets, so view
    // normals are stored signed and raw. SSGINode consumes them via .sample().rgb.
    const scenePass = pass(scene, camera);
    scenePass.setMRT(
      mrt({
        output: output,
        albedo: diffuseColor,
        normal: normalView,
        velocity: velocity,
      }),
    );
    this.scenePass = scenePass;

    const color = scenePass.getTextureNode('output').toInspector('GBuffer / HDR');
    const albedo = scenePass
      .getTextureNode('albedo')
      .toInspector('GBuffer / Albedo');
    const normal = scenePass
      .getTextureNode('normal')
      .toInspector('GBuffer / Normal', (node) => vec4(node.rgb.mul(0.5).add(0.5), 1));
    const depth = scenePass
      .getTextureNode('depth')
      .toInspector('GBuffer / Depth', () => scenePass.getLinearDepthNode());
    const vel = scenePass.getTextureNode('velocity');
    this.tap('GBuffer / Velocity', vec4(vel.rg.abs().mul(20), 0, 1));

    // ---- 5. GI ---------------------------------------------------------------
    // The indirect term is NOT computed here. It comes from the world-space
    // irradiance cache (src/shared/gi), traced against the BVH and sampled per pixel
    // inside the material — so it is real traced bounce, not a screen-space guess,
    // and it survives the camera looking away.
    //
    // SSGI stays available as an optional *near-field* refinement on top of that
    // cache, exactly as Lumen layers screen traces over its world cache. It is OFF
    // by default: as the only GI term it is just noise, which is the trap this
    // pipeline was rebuilt to avoid.
    const ssgiNode = ssgi(color, depth, normal, camera);
    this.ssgiNode = ssgiNode;
    this.applySsgiParams();

    const gi = ssgiNode.rgb.toInspector('SSGI / GI', (node) => vec4(node, 1));
    const ao = ssgiNode.a.toInspector('SSGI / AO', (node) => vec4(node, node, node, 1));

    // ---- SLOT (Phase 4): + sky / aerial perspective / froxel fog -------------

    // ---- 6. Compose ----------------------------------------------------------
    const composed = this.useScreenTraces
      ? vec4(add(color.rgb.mul(ao), albedo.rgb.mul(gi)), color.a)
      : (color as unknown as TslNode);
    if (!this.useScreenTraces) {
      // Keep the SSGI buffers inspectable even when they are not composited, so the
      // pass viewer can show what the near-field term *would* contribute.
      this.tap('SSGI / GI', vec4(gi, 1));
      this.tap('SSGI / AO', vec4(ao, ao, ao, 1));
    }

    // ---- 10. Temporal reconstruction ----------------------------------------
    const resolved = traa(composed, depth, vel, camera) as unknown as TslNode;

    // ---- SLOT (Phase 5): bloom → exposure → grade → grain -------------------

    this.post.outputNode = this.foldTaps(resolved);
  }

  /**
   * Registers a buffer for the Inspector's Viewer tab.
   *
   * `toInspector()` attaches via `node.before(...)`, so a node that nothing
   * downstream consumes is never built and never shows up. Buffers we do not
   * otherwise read (velocity, and later the shadow layers) are therefore folded
   * into the output at zero weight. Dev-only: `debugTaps = false` drops them.
   */
  private tap(name: string, displayNode: TslNode): void {
    if (!this.debugTaps) return;
    this.taps.push({ name, node: displayNode });
  }

  private foldTaps(outputNode: TslNode): TslNode {
    // A literal `* 0` gets constant-folded away and the tapped node is never built,
    // so the Inspector never sees it. A uniform cannot be folded.
    const zero = uniform(0);
    let node = outputNode;
    for (const { name, node: display } of this.taps) {
      node = node.add(display.toInspector(name).mul(zero)) as TslNode;
    }
    return node;
  }

  private applySsgiParams(): void {
    const p = this.ssgiParams;
    const n = this.ssgiNode;
    n.sliceCount.value = p.sliceCount;
    n.stepCount.value = p.stepCount;
    n.aoIntensity.value = p.aoIntensity;
    n.giIntensity.value = p.giIntensity;
    n.expFactor.value = p.expFactor;
    n.thickness.value = p.thickness;
    n.backfaceLighting.value = p.backfaceLighting;
  }

  /** Call after mutating `ssgiParams` (e.g. from the GUI). */
  syncSsgiParams(): void {
    this.applySsgiParams();
  }

  setSize(width: number, height: number): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.post.needsUpdate = true;
  }

  render(): void {
    this.post.render();
  }
}
