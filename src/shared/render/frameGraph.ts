import * as THREE from 'three/webgpu';
import {
  diffuseColor,
  mrt,
  normalView,
  output,
  pass,
  screenUV,
  texture,
  vec2,
  uniform,
  vec4,
  velocity,
} from 'three/tsl';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { reflectTextures } from '../gi/reflect/settings.ts';

/**
 * TSL's fluent API returns a different concrete node class per operator, so the
 * chain is typed against the shared surface rather than any one of them.
 */
type TslNode = THREE.Node;

export const GiMode = {
  Direct: 'direct',
  Indirect: 'indirect',
  Combined: 'combined',
} as const;
export type GiMode = (typeof GiMode)[keyof typeof GiMode];

/**
 * Right-hand pane of the split view. Same screen UV as the left, so the two halves
 * line up pixel for pixel and a buffer can be read against the shading it produced.
 */
export const SplitView = {
  Off: 'off',
  /** Raw resolve output: the radiance gathered from the surfel cache. */
  Gi: 'gi',
  /** That radiance times albedo — the indirect term as it enters the composite. */
  Indirect: 'indirect',
  /** Direct lighting alone. */
  Direct: 'direct',
  Albedo: 'albedo',
  Normal: 'normal',
  /** The baked cache itself, laid out as a 2D atlas — one texel per surfel. */
  Cache: 'cache',
  /** The baked lightmap texture, shown flat. */
  Lightmap: 'lightmap',
  /**
   * Upstream's per-pixel surfel gather, run alongside the screen probes into its
   * own texture. This is the A/B: the same frame, the same pixels, the old final
   * gather on the right and the new one on the left.
   */
  Surfel: 'surfel',
  /** Screen-probe placement: tile grid, probe normals, adaptive probes. */
  Probes: 'probes',
  /** The specular gather on its own, before it is added to anything. */
  Reflect: 'reflect',
} as const;
export type SplitView = (typeof SplitView)[keyof typeof SplitView];

export interface FrameGraphOptions {
  giMode?: GiMode;
  indirectIntensity?: number;
  splitView?: SplitView;
  debugTaps?: boolean;
}

/**
 * Elderwood frame graph.
 *
 * ```
 * scene pass → MRT( HDR | albedo | view normal | velocity | depth )
 *            → composite( direct + indirect × albedo )      ← surfel GI resolve
 *            → FXAA
 * ```
 *
 * The composite is rebuilt on demand rather than once at construction, because the
 * GI resolve target is created lazily and replaced on resize — the same reason
 * webgiya rebuilds its composite material.
 *
 * Slots still to fill, in UE order (docs/ue-pipeline-study-and-plan.md §3.4):
 *   Phase 1  cached static/dynamic cascade shadows, feeding the base pass
 *   Phase 4  sky LUT + aerial perspective + froxel fog, before AA
 *   Phase 5  bloom → exposure → grade → grain, and TRAA in place of FXAA
 */
export class FrameGraph {
  readonly post: THREE.PostProcessing;
  readonly scenePass: ReturnType<typeof pass>;

  giMode: GiMode;
  readonly indirectIntensity = uniform(1);
  /**
   * Where the divider sits, `?splitAt=` overriding the half-and-half default.
   *
   * Read here rather than threaded through the composition root for the reason
   * `surfel/knobs.ts` gives at length, and it earns its keep immediately: `?splitAt=0`
   * turns the split view into a full-frame view of one buffer, which is the only way to
   * diff a buffer against itself under an ablation without the beauty pass's own
   * differences sitting in the same image. Half a frame of specular cannot answer a
   * question about the other half.
   */
  splitPosition = FrameGraph.readSplitAt();
  private splitView: SplitView = SplitView.Off;
  /** Supplied by the app once the GI cache exists; see gi/cacheAtlas.ts. */
  private cacheAtlasNode: ((uv: unknown) => unknown) | null = null;
  private lightmapTexture: THREE.Texture | null = null;

  private readonly color: TslNode;
  private readonly taps: Array<{ name: string; node: TslNode }> = [];
  private readonly debugTaps: boolean;

  private reflectTexture: THREE.Texture | null = null;
  private giTexture: THREE.Texture | null = null;
  private albedoTexture: THREE.Texture | null = null;
  private surfelTexture: THREE.Texture | null = null;
  private probeDebugTexture: THREE.Texture | null = null;
  private needsComposite = true;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    options: FrameGraphOptions = {},
  ) {
    const {
      giMode = GiMode.Combined,
      indirectIntensity = 1,
      splitView = SplitView.Off,
      debugTaps = true,
    } = options;
    this.giMode = giMode;
    this.indirectIntensity.value = indirectIntensity;
    this.splitView = splitView;
    this.debugTaps = debugTaps;

    this.post = new THREE.PostProcessing(renderer);

    const scenePass = pass(scene, camera);
    scenePass.setMRT(
      mrt({
        output: output,
        albedo: diffuseColor,
        normal: normalView,
        velocity: velocity,
        // NO metalness/roughness attachment here, though this is where it belongs.
        // Four RGBA16F attachments is 32 bytes per sample, which is exactly
        // `maxColorAttachmentBytesPerSample` on this adapter; a fifth of any format
        // fails validation and invalidates the whole command buffer. The reflection
        // pass therefore rasterises its own half-resolution material buffer. Shrinking
        // `velocity` to RG16F would free the room, but the per-attachment format of a
        // PassNode MRT is not addressable without reaching into its private texture
        // map, and a half-res raster of a scene that has no glossy material in it is
        // skipped entirely.
      }),
    );
    this.scenePass = scenePass;

    this.color = scenePass.getTextureNode('output').toInspector('Direct / HDR');

    this.tap('GBuffer / Albedo', vec4(scenePass.getTextureNode('albedo').rgb, 1));
    this.tap(
      'GBuffer / Normal',
      vec4(scenePass.getTextureNode('normal').rgb.mul(0.5).add(0.5), 1),
    );
    this.tap(
      'GBuffer / Velocity',
      vec4(scenePass.getTextureNode('velocity').rg.abs().mul(20), 0, 1),
    );

    this.rebuildComposite();
  }

  /**
   * Points the composite at the GI resolve output. Safe to call every frame; the
   * node graph is only rebuilt when a texture identity actually changed.
   */
  setGiTextures(gi: THREE.Texture | null, albedo: THREE.Texture | null): void {
    if (gi === this.giTexture && albedo === this.albedoTexture) return;
    this.giTexture = gi;
    this.albedoTexture = albedo;
    this.needsComposite = true;
  }

  /**
   * The two comparison panes. Both are written by the resolve pass and neither
   * takes part in the composite — they exist so a claim about the final gather
   * can be read off one screenshot instead of two.
   */
  setProbeTextures(surfel: THREE.Texture | null, debug: THREE.Texture | null): void {
    if (surfel === this.surfelTexture && debug === this.probeDebugTexture) return;
    this.surfelTexture = surfel;
    this.probeDebugTexture = debug;
    this.needsComposite = true;
  }

  setGiMode(mode: GiMode): void {
    if (mode === this.giMode) return;
    this.giMode = mode;
    this.needsComposite = true;
  }

  /** The baked lightmap, for the split view's `lightmap` pane. */
  setLightmapTexture(tex: THREE.Texture | null): void {
    if (tex === this.lightmapTexture) return;
    this.lightmapTexture = tex;
    this.needsComposite = true;
  }

  /** Hands the frame graph a uv -> colour function that draws the surfel cache. */
  setCacheAtlasNode(node: ((uv: unknown) => unknown) | null): void {
    this.cacheAtlasNode = node;
    this.needsComposite = true;
  }

  setSplitView(view: SplitView): void {
    if (view === this.splitView) return;
    this.splitView = view;
    this.needsComposite = true;
  }

  /** Rebuild on the next render — used when a baked-in constant like the divider moves. */
  forceRebuild(): void {
    this.needsComposite = true;
  }

  private tap(name: string, displayNode: TslNode): void {
    if (!this.debugTaps) return;
    this.taps.push({ name, node: displayNode });
  }

  private foldTaps(outputNode: TslNode): TslNode {
    // A literal `* 0` is constant-folded away and the tapped node never gets built,
    // so the Inspector never sees it. A uniform cannot be folded.
    const zero = uniform(0);
    let node = outputNode;
    for (const { name, node: display } of this.taps) {
      node = node.add(display.toInspector(name).mul(zero)) as TslNode;
    }
    return node;
  }

  private rebuildComposite(): void {
    let beauty: TslNode = this.color;
    let giRaw: TslNode | null = null;
    let indirect: TslNode | null = null;
    /**
     * The specular term arrives already multiplied by Fresnel and the GGX visibility
     * ratio, so it is a straight add rather than something the composite has to weight.
     * That is deliberate: the reflection pass is the only place that holds N, V,
     * roughness, metalness and albedo at once, and splitting the BRDF across two files
     * is how a factor of pi goes missing.
     *
     * Purely additive is also correct here rather than merely convenient — no material
     * in this build has an env map and `scene.environment` is never set, so a metal
     * surface currently receives no image-based specular at all. There is nothing to
     * double-count. The day an env map lands on the materials, this add becomes a
     * replace and this comment becomes the bug report.
     */
    const specular: TslNode | null = this.reflectTexture
      ? (texture(this.reflectTexture, screenUV).toInspector('GI / Reflection') as TslNode)
      : null;

    if (this.giTexture && this.albedoTexture) {
      const albedo = texture(this.albedoTexture, screenUV);
      giRaw = texture(this.giTexture, screenUV).toInspector('GI / Surfel');
      indirect = (giRaw as ReturnType<typeof texture>)
        .mul(albedo)
        .mul(this.indirectIntensity);
      // A metal has no diffuse lobe, and this composite has no material knowledge to
      // work that out with — so the reflection pass hands it `1 - metalness` in the
      // alpha it was already sampling. Absent that pass the factor is not applied at
      // all rather than defaulted, which keeps every scene without a metal in it
      // producing the exact composite it produced before.
      if (specular) {
        indirect = (indirect as ReturnType<typeof texture>).mul(
          (specular as ReturnType<typeof texture>).a,
        );
      }

      switch (this.giMode) {
        case GiMode.Direct:
          beauty = this.color;
          break;
        case GiMode.Indirect:
          beauty = indirect;
          break;
        default:
          beauty = (this.color as ReturnType<typeof vec4>).add(indirect);
          break;
      }
    }

    // Outside the giTexture branch: a mirror is not a consequence of the diffuse gather
    // existing, and `?probes=0&gi=0` must still reflect. Skipped in Indirect mode, which
    // is a diagnostic pane for the diffuse term and would stop meaning that.
    if (specular && this.giMode !== GiMode.Indirect) {
      beauty = (beauty as ReturnType<typeof vec4>).add(
        vec4((specular as ReturnType<typeof texture>).rgb, 0),
      ) as TslNode;
    }

    const composed = this.applySplit(beauty, giRaw, indirect, specular);
    this.post.outputNode = this.foldTaps(fxaa(composed) as unknown as TslNode);
    this.post.needsUpdate = true;
    this.needsComposite = false;
  }

  /**
   * Draws a chosen buffer into the right half of the frame at the same screen UV, so
   * the shading and the buffer that produced it can be read against each other
   * without switching modes and losing the comparison.
   */
  private applySplit(
    beauty: TslNode,
    giRaw: TslNode | null,
    indirect: TslNode | null,
    specular: TslNode | null,
  ): TslNode {
    if (this.splitView === SplitView.Off) return beauty;

    let right: TslNode | null = null;
    switch (this.splitView) {
      case SplitView.Gi:
        right = giRaw;
        break;
      case SplitView.Indirect:
        right = indirect;
        break;
      case SplitView.Direct:
        right = this.color;
        break;
      case SplitView.Albedo:
        right = this.albedoTexture ? texture(this.albedoTexture, screenUV) : null;
        break;
      case SplitView.Normal:
        right = vec4(
          this.scenePass.getTextureNode('normal').rgb.mul(0.5).add(0.5),
          1,
        );
        break;
      case SplitView.Surfel:
        // Times albedo, like the Indirect pane: the raw gather is a quantity
        // nobody can judge by eye, the light it puts on the wall is.
        if (this.surfelTexture && this.albedoTexture) {
          right = texture(this.surfelTexture, screenUV)
            .mul(texture(this.albedoTexture, screenUV))
            .mul(this.indirectIntensity);
        }
        break;
      case SplitView.Reflect:
        // Unlike the GI pane this needs no albedo multiply: the specular gather already
        // carries F and the visibility ratio, so what is drawn here is exactly what the
        // composite adds.
        if (specular) right = vec4((specular as ReturnType<typeof texture>).rgb, 1);
        break;
      case SplitView.Probes:
        if (this.probeDebugTexture) {
          right = vec4(texture(this.probeDebugTexture, screenUV).rgb, 1);
        }
        break;
      case SplitView.Lightmap:
        if (this.lightmapTexture) {
          // Remap the pane to a full square so the atlas is shown whole.
          const lmUv = vec2(
            screenUV.x.sub(this.splitPosition).div(1 - this.splitPosition),
            screenUV.y,
          );
          right = vec4(texture(this.lightmapTexture, lmUv).rgb, 1);
        }
        break;
      case SplitView.Cache:
        if (this.cacheAtlasNode) {
          // Remap the right pane back to a full 0..1 square so the atlas is shown
          // whole rather than cropped to whatever aspect the pane happens to be.
          const local = vec2(
            screenUV.x.sub(this.splitPosition).div(1 - this.splitPosition),
            screenUV.y,
          );
          right = this.cacheAtlasNode(local) as TslNode;
        }
        break;
    }
    if (right === null) return beauty;

    const split = this.splitPosition;
    const picked = screenUV.x.lessThan(split).select(beauty, right);

    // A one-pixel-ish seam, so the boundary is unmistakable in a screenshot.
    const seam = screenUV.x.sub(split).abs().lessThan(0.0012);
    return seam.select(vec4(1, 0.35, 0.1, 1), picked) as unknown as TslNode;
  }

  private static readSplitAt(): number {
    if (typeof window === 'undefined') return 0.5;
    const raw = new URLSearchParams(window.location.search).get('splitAt');
    if (raw === null || raw === '') return 0.5;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
  }

  setSize(width: number, height: number): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.post.needsUpdate = true;
  }

  render(): void {
    // Polled rather than pushed. The reflection target is created lazily and replaced on
    // resize, exactly like the GI one — but `setGiTextures` has a call site in the
    // composition root and this does not, so the identity check happens here instead of
    // in a setter someone else would have to call.
    if (reflectTextures.reflection !== this.reflectTexture) {
      this.reflectTexture = reflectTextures.reflection;
      this.needsComposite = true;
    }
    if (this.needsComposite) this.rebuildComposite();
    this.post.render();
  }
}
