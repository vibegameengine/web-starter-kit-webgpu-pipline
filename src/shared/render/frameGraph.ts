import * as THREE from 'three/webgpu';
import {
  diffuseColor,
  mrt,
  normalView,
  float,
  mix,
  output,
  pass,
  rtt,
  screenUV,
  texture,
  vec2,
  uniform,
  vec4,
  velocity,
} from 'three/tsl';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { Layer } from '../world/index.ts';

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
} as const;
export type SplitView = (typeof SplitView)[keyof typeof SplitView];

export interface FrameGraphOptions {
  giMode?: GiMode;
  indirectIntensity?: number;
  splitView?: SplitView;
  debugTaps?: boolean;
  /**
   * Adds the overlay pass: objects on `Layer.Overlay` (water) are drawn after the GI
   * composite by a copy of the camera that sees only that layer, with the composited
   * colour and the scene depth available to their materials. See `onScreenTextures`.
   */
  overlay?: boolean;
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
 *   Phase 4  froxel fog is in (`setAtmosphere`, shared/render/atmosphere); sky LUT and
 *            aerial perspective wait for a scene with a sky
 *   Phase 5  bloom → exposure → grade → grain, and TRAA in place of FXAA
 */
export class FrameGraph {
  readonly post: THREE.PostProcessing;
  readonly scenePass: ReturnType<typeof pass>;

  giMode: GiMode;
  readonly indirectIntensity = uniform(1);
  /** Suppress realtime GI only on receivers already lit by the baked atlas. */
  readonly hybridReceivers = uniform(0);
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

  private giTexture: THREE.Texture | null = null;
  private albedoTexture: THREE.Texture | null = null;
  private needsComposite = true;

  /** Single-layer translucents (water) drawn over the composite. Null without `overlay`. */
  readonly overlayPass: ReturnType<typeof pass> | null = null;
  private readonly overlayCamera: THREE.PerspectiveCamera | null = null;
  private readonly camera: THREE.PerspectiveCamera;
  /**
   * Called whenever the composite is rebuilt, with the textures an overlay material
   * reads: the composited scene colour (a render-to-texture of the beauty node) and the
   * scene pass depth. Both change identity on rebuild and resize, hence a callback.
   */
  onScreenTextures: ((color: THREE.Texture, depth: THREE.Texture, normal: THREE.Texture) => void) | null = null;
  /**
   * Participating medium over the finished composite: `(colour, rawDepth) => colour`,
   * evaluated in linear HDR after the overlay and before AA. The depth is the nearest
   * of the scene and overlay passes, so water is fogged at its own surface. Null = off,
   * and nothing of it remains in the shader.
   */
  private atmosphere: ((beauty: TslNode, depth: TslNode) => TslNode) | null = null;
  /**
   * Veiling glare: a zero-threshold bloom of the whole HDR frame mixed in by a small
   * fraction, after the fog and before AA. Not a "bright things glow" effect — it is the
   * fraction of every pixel's light that a lens and an eye scatter over their
   * neighbours, which is what takes the cut-out hardness off edges between differently
   * lit surfaces. Energy conserving. Both knobs are uniforms; null drops the stage.
   */
  private glare: { strength: THREE.UniformNode<number>; radius: THREE.UniformNode<number> } | null = null;

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
      overlay = false,
    } = options;
    this.camera = camera;
    if (overlay) {
      const overlayCamera = camera.clone();
      overlayCamera.layers.set(Layer.Overlay);
      this.overlayCamera = overlayCamera;
      this.overlayPass = pass(scene, overlayCamera);
    }
    this.giMode = giMode;
    this.indirectIntensity.value = indirectIntensity;
    this.splitView = splitView;
    this.debugTaps = debugTaps;

    this.post = new THREE.PostProcessing(renderer);

    const scenePass = pass(scene, camera);
    const bakedReceiver = uniform(0).onObjectUpdate(({ object }) => object?.userData.bakedLightReceiver ? 1 : 0);
    scenePass.setMRT(
      mrt({
        output: output,
        albedo: vec4(diffuseColor.rgb, bakedReceiver),
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

  /** Installs or removes the fog/atmosphere stage; the composite is rebuilt either way. */
  setAtmosphere(apply: ((beauty: THREE.Node, depth: THREE.Node) => THREE.Node) | null): void {
    if (apply === this.atmosphere) return;
    this.atmosphere = apply;
    this.needsComposite = true;
  }

  /**
   * Installs or removes the veiling-glare stage. `strength` is the fraction of light
   * moved into the spread (0.03–0.08 reads as a clean lens), `radius` the spread in [0, 1].
   */
  setGlare(settings: { strength: number; radius: number } | null): void {
    if (settings === null) {
      if (this.glare === null) return;
      this.glare = null;
    } else if (this.glare === null) {
      this.glare = { strength: uniform(settings.strength), radius: uniform(settings.radius) };
    } else {
      this.glare.strength.value = settings.strength;
      this.glare.radius.value = settings.radius;
      return;
    }
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

    if (this.giTexture && this.albedoTexture) {
      const albedo = texture(this.albedoTexture, screenUV);
      giRaw = texture(this.giTexture, screenUV).toInspector('GI / Surfel');
      indirect = (giRaw as ReturnType<typeof texture>)
        .mul(albedo)
        .mul(this.indirectIntensity)
        .mul(this.scenePass.getTextureNode('albedo').a.mul(this.hybridReceivers).oneMinus());

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

    if (this.overlayPass) {
      // The composite becomes a texture the overlay can refract through; the overlay
      // pass writes premultiplied colour with coverage in alpha, so a frame with no
      // overlay object is the composite unchanged.
      const sceneColor = rtt(beauty as ReturnType<typeof vec4>);
      const over = this.overlayPass.getTextureNode('output');
      // Premultiplied: the overlay's opaque water writes (rgb, 1), its droplets write
      // (rgb·a, a); one formula composes both without squaring anyone's coverage.
      beauty = sceneColor.mul(float(1.0).sub(over.a)).add(over.rgb) as unknown as TslNode;
      this.onScreenTextures?.(sceneColor.value as THREE.Texture, this.scenePass.getTexture('depth'), this.scenePass.getTexture('normal'));
    }

    if (this.atmosphere) {
      // The overlay pass clears its depth to the far plane where it drew nothing, so
      // the nearer of the two is the surface the pixel actually shows.
      let depth: TslNode = this.scenePass.getTextureNode('depth');
      if (this.overlayPass) {
        depth = (depth as ReturnType<typeof texture>).min(this.overlayPass.getTextureNode('depth')) as unknown as TslNode;
      }
      beauty = this.atmosphere(beauty, depth).toInspector('Atmosphere / Fogged') as unknown as TslNode;
    }

    if (this.glare) {
      // Threshold 0: every photon scatters a little, dim surfaces included. Energy
      // conserving: the strength is the fraction of light *moved* into the spread, not
      // added on top, so the frame does not get brighter. Linear HDR, before tone mapping.
      // three's BloomNode sums five mips with weights that always total 3.0 (each is
      // mix(f, 1.2 - f, radius) over f = 1.0..0.2), so a flat field comes back 3x; the
      // division makes the spread a unit-gain blur before it is mixed in.
      const spread = bloom(beauty as ReturnType<typeof vec4>, 1, 0, 0);
      spread.radius = this.glare.radius;
      const unitSpread = spread.div(3).toInspector('Post / Veiling glare');
      beauty = mix(beauty as ReturnType<typeof vec4>, unitSpread, this.glare.strength) as unknown as TslNode;
    }

    const composed = this.applySplit(beauty, giRaw, indirect);
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
    if (this.needsComposite) this.rebuildComposite();
    if (this.overlayCamera) {
      // Same eye, same lens, one layer: `copy` takes the layers with it, so reset them.
      this.overlayCamera.copy(this.camera, false);
      this.overlayCamera.layers.set(Layer.Overlay);
      this.overlayCamera.updateMatrixWorld();
    }
    this.post.render();
  }
}
