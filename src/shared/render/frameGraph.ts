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
  vec3,
  uniform,
  vec4,
  velocity,
} from 'three/tsl';
import { bakedIndirect } from '../gi/bake/applyLightmap.ts';
import { DFGLUT, getViewPosition, cameraProjectionMatrixInverse, cameraWorldMatrix, normalize, luminance, metalness, roughness, cameraNear, cameraFar } from 'three/tsl';
import { MotionBlur } from './motionBlur.ts';
import { applyOutputStages } from './outputStage.ts';
import { artisticIndirect, type ArtisticLook } from './look.ts';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { TemporalAANode } from './temporalAA.ts';

export type Antialiasing = 'taa' | 'fxaa' | 'none';
import { Layer } from '../world/index.ts';

/**
 * TSL's fluent API returns a different concrete node class per operator, so the
 * chain is typed against the shared surface rather than any one of them.
 */
type TslNode = THREE.Node;

const frameSize = new THREE.Vector2();

/** Inverse of the contact pass's octahedral encoding (see contactOcclusionPass.ts). */
const octDecode = (p: ReturnType<typeof vec2>) => {
  const z = float(1).sub(p.x.abs()).sub(p.y.abs());
  const t = z.negate().max(0);
  const x = p.x.add(p.x.greaterThanEqual(0).select(t.negate(), t));
  const y = p.y.add(p.y.greaterThanEqual(0).select(t.negate(), t));
  return vec3(x, y, z).normalize();
};

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
  /** Contact occlusion: visible fraction of the near hemisphere, white = open. */
  Contact: 'contact',
  /** Contact bent normal, world space, 0.5 + 0.5. */
  BentNormal: 'bentNormal',
  /** Traced specular radiance before the BRDF weight. */
  Reflections: 'reflections',
  Baked: 'baked',
  Leak: 'leak',
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
  /** `taa` (default) accumulates over frames with a jittered camera; `fxaa` is the old single-frame pass. */
  antialiasing?: Antialiasing;
}

export class FrameGraph {
  readonly post: THREE.PostProcessing;
  readonly scenePass: ReturnType<typeof pass>;

  giMode: GiMode;
  readonly indirectIntensity = uniform(1);
  /* @important 1 while an atlas is published: a baked receiver (albedo alpha) keeps the atlas light and
     does not get the live indirect on top; the mode collapse once left this at 0 and doubled every
     static surface. */
  readonly hybridReceivers = uniform(0);
  splitPosition = FrameGraph.readSplitAt();
  private splitView: SplitView = SplitView.Off;
  /** Supplied by the app once the GI cache exists; see gi/cacheAtlas.ts. */
  private cacheAtlasNode: ((uv: unknown) => unknown) | null = null;
  private lightmapTexture: THREE.Texture | null = null;
  private leakTexture: THREE.Texture | null = null;

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
  onScreenTextures: ((color: THREE.Texture, depth: THREE.Texture, normal: THREE.Texture) => void) | null = null;
  private atmosphere: ((beauty: TslNode, depth: TslNode) => TslNode) | null = null;
  private glare: { strength: THREE.UniformNode<number>; radius: THREE.UniformNode<number> } | null = null;
  private antialiasing: Antialiasing;
  /** Scene-referred exposure multiplier (a GPU value from the meter), applied after AA, before tone mapping. Null = 1. */
  private exposureNode: TslNode | null = null;
  private look: ArtisticLook | null = null;
  /** Film grain strength in display space, after tone mapping; null = none. */
  private grain: THREE.UniformNode<number> | null = null;
  /** Per-pixel motion blur after the temporal resolve (see motionBlur.ts); null = off. */
  private motionBlur: MotionBlur | null = null;
  /** Frame counter for the grain's per-frame noise. */
  private readonly frameIndex = uniform(0);
  /** Counts FrameGraph.render() calls; the composite copies render once per value. */
  private frameSerial = 0;
  /**
   * Contact occlusion reader: `(screenUV) => vec4(oct.xy, visibility, viewDepth)` from
   * the pass's storage buffers, plus its strength. Multiplies the indirect terms only;
   * direct light is already shadowed. Null = off.
   */
  private contact: { sample: (uv: TslNode) => TslNode; intensity: THREE.UniformNode<number> } | null = null;
  /**
   * Reflection reader: `(screenUV) => vec4(radiance, confidence)`, the G-buffer's
   * strength; F0 and roughness come from the scene G-buffer. The specular term is
   * added on top of the composite: materials here carry no environment specular of
   * their own, so nothing is counted twice.
   */
  private reflections: { sample: (uv: TslNode) => TslNode; intensity: THREE.UniformNode<number> } | null = null;
  private probeRadiance: ((worldPosition: TslNode, direction: TslNode) => TslNode) | null = null;
  /** Owns the jitter and the history; idle unless the mode is `taa`. */
  readonly taa: TemporalAANode;

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
      antialiasing = 'taa',
    } = options;
    this.camera = camera;
    this.antialiasing = antialiasing;
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
        normal: vec4(normalView, luminance(bakedIndirect)),
        velocity: vec4(velocity, metalness, roughness),
      }),
    );
    this.scenePass = scenePass;
    this.taa = new TemporalAANode(null, scenePass.getTextureNode('depth'), scenePass.getTextureNode('velocity'), camera);

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
  get split(): SplitView { return this.splitView; }

  setLeakTexture(tex: THREE.Texture | null): void {
    if (tex === this.leakTexture) return;
    this.leakTexture = tex;
    this.needsComposite = true;
  }

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

  /** Installs or removes the contact-occlusion reader; the composite is rebuilt. */
  setContactOcclusion(reader: { sample: (uv: TslNode) => TslNode; intensity: THREE.UniformNode<number> } | null): void {
    if (reader === this.contact) return;
    this.contact = reader;
    this.needsComposite = true;
  }

  private bakedIndirectNode(): TslNode {
    const albedo = this.scenePass.getTextureNode('albedo').rgb;
    return albedo.mul(this.scenePass.getTextureNode('normal').a.div(luminance(albedo).max(1e-3)));
  }

  /** Installs or removes the traced-reflection reader; the composite is rebuilt. */
  setReflections(reader: { sample: (uv: TslNode) => TslNode; intensity: THREE.UniformNode<number> } | null): void {
    if (reader === this.reflections) return;
    this.reflections = reader;
    this.needsComposite = true;
  }

  setProbeRadiance(sampler: ((worldPosition: TslNode, direction: TslNode) => TslNode) | null): void {
    if (sampler === this.probeRadiance) return;
    this.probeRadiance = sampler;
    this.needsComposite = true;
  }

  /** Installs the exposure multiplier node (see shared/render/exposure.ts). */
  setExposure(node: TslNode | null): void {
    if (node === this.exposureNode) return;
    this.exposureNode = node;
    this.needsComposite = true;
  }

  setLook(look: ArtisticLook | null): void {
    if (look === this.look) return;
    this.look = look;
    this.needsComposite = true;
  }

  /**
   * Film grain: display-referred noise after tone mapping, weighted toward the shadows
   * where film and sensors are noisiest. `strength` is a uniform; null removes the stage
   * and hands the output transform back to three.
   */
  setGrain(strength: THREE.UniformNode<number> | null): void {
    if (strength === this.grain) return;
    this.grain = strength;
    this.needsComposite = true;
  }

  /** Installs or removes the motion blur pass; the composite is rebuilt. */
  setMotionBlur(pass: MotionBlur | null): void {
    if (pass === this.motionBlur) return;
    this.motionBlur = pass;
    this.needsComposite = true;
  }

  setAntialiasing(mode: Antialiasing): void {
    if (mode === this.antialiasing) return;
    this.antialiasing = mode;
    this.taa.reset();
    this.needsComposite = true;
  }

  get antialiasingMode(): Antialiasing {
    return this.antialiasing;
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

    // Contact occlusion of everything indirect: the live surfel term below and, through
    // the G-buffer's baked-indirect channels, the lightmap term inside the scene colour.
    let occlusion: TslNode | null = null;
    if (this.contact) {
      const c = this.contact.sample(screenUV as unknown as TslNode) as ReturnType<typeof vec4>;
      // `.toInspector` here, not `this.tap()`: taps accumulate across rebuilds, and a
      // reallocated contact buffer would leave the old one bound for good (every
      // rebuild added a storage binding until the fragment shader failed to compile).
      occlusion = mix(float(1), c.z.toInspector('Contact / Visibility'), this.contact.intensity) as unknown as TslNode;
    }

    if (this.giTexture && this.albedoTexture) {
      const albedo = texture(this.albedoTexture, screenUV);
      giRaw = texture(this.giTexture, screenUV).toInspector('GI / Surfel');
      indirect = vec4(artisticIndirect((giRaw as ReturnType<typeof texture>).rgb), 1)
        .mul(albedo)
        .mul(this.indirectIntensity)
        .mul(this.scenePass.getTextureNode('albedo').a.mul(this.hybridReceivers).oneMinus());
      if (occlusion) indirect = (indirect as ReturnType<typeof vec4>).mul(occlusion) as unknown as TslNode;

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
    if (this.reflections) {
      // Split-sum specular: traced radiance x (F0*A + F90*B) from three's DFG LUT, then
      // the contact bent-cone occlusion (Lagarde's form, as three applies it to
      // environment specular) so reflections do not leak into crevices.
      const r = this.reflections.sample(screenUV as unknown as TslNode) as ReturnType<typeof vec4>;
      const material = this.scenePass.getTextureNode('velocity');
      const f0 = mix(vec3(0.04), this.scenePass.getTextureNode('albedo').rgb, material.b);
      const rough = material.a.clamp(0.02, 1);
      const depthNode = this.scenePass.getTextureNode('depth');
      const viewPos = getViewPosition(screenUV, depthNode, cameraProjectionMatrixInverse);
      const nView = normalize(this.scenePass.getTextureNode('normal').rgb);
      const dotNV = nView.dot(normalize(viewPos.negate())).clamp(0, 1);
      const fab = DFGLUT({ dotNV, roughness: rough });
      const brdf = f0.mul(fab.x).add(fab.y);
      let so: TslNode = float(1);
      if (occlusion) {
        const aoNV = dotNV.add(occlusion as ReturnType<typeof float>);
        const aoExp = rough.mul(-16).sub(1).exp2();
        so = (occlusion as ReturnType<typeof float>).sub(aoNV.pow(aoExp).oneMinus()).clamp() as unknown as TslNode;
      }
      let radiance: TslNode = r.rgb.mul(r.a);
      if (this.probeRadiance) {
        const worldPos = cameraWorldMatrix.mul(vec4(viewPos, 1)).xyz;
        const nWorld = normalize(cameraWorldMatrix.mul(vec4(nView, 0)).xyz);
        const viewDir = normalize(worldPos.sub(cameraWorldMatrix[3].xyz));
        const reflected = viewDir.sub(nWorld.mul(viewDir.dot(nWorld).mul(2)));
        const rough = vec3(this.probeRadiance(worldPos as unknown as TslNode, reflected as unknown as TslNode)).toInspector('Reflections / Probe fallback');
        radiance = (radiance as ReturnType<typeof vec3>).add(rough.mul(float(1).sub(r.a)));
      }
      const specularLight = vec3(radiance).mul(brdf).mul(so).mul(this.reflections.intensity).toInspector('Reflections / Specular');
      beauty = vec4(vec3(beauty).add(specularLight), vec4(beauty).a) as unknown as TslNode;
    }
    if (occlusion) {
      const baked = this.bakedIndirectNode();
      beauty = vec4(vec3(beauty).sub(baked.mul(float(1).sub(occlusion))), vec4(beauty).a) as unknown as TslNode;
    }

    if (this.overlayPass) {
      // The composite becomes a texture the overlay can refract through; the overlay
      // pass writes premultiplied colour with coverage in alpha, so a frame with no
      // overlay object is the composite unchanged.
      const sceneColor = this.copyOncePerFrame(rtt(beauty as ReturnType<typeof vec4>), 'composite.beforeOverlay');
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
    let resolved: TslNode;
    if (this.antialiasing === 'taa') {
      // The frame is accumulated as a texture: the resolve loads its 3x3 texels.
      this.taa.setInput(this.copyOncePerFrame(rtt(composed as ReturnType<typeof vec4>), 'composite.taaInput'));
      resolved = this.taa.getTextureNode().toInspector('AA / Temporal') as unknown as TslNode;
    } else if (this.antialiasing === 'fxaa') {
      resolved = fxaa(composed) as unknown as TslNode;
    } else {
      resolved = composed;
    }
    if (this.motionBlur) {
      // After the resolve (the history stays sharp), on the resolved frame as a texture.
      const sharp = this.copyOncePerFrame(rtt(resolved as ReturnType<typeof vec4>), 'composite.beforeMotionBlur');
      resolved = this.motionBlur.apply(
        (at) => sharp.sample(at),
        this.scenePass.getTexture('velocity'),
        this.scenePass.getTexture('depth'),
        cameraNear,
        cameraFar,
      ).toInspector('Post / Motion blur') as unknown as TslNode;
    }
    const output = applyOutputStages(resolved, { exposure: this.exposureNode, look: this.look, grain: this.grain, frameIndex: this.frameIndex });
    this.post.outputColorTransform = output.outputColorTransform;
    this.post.outputNode = this.foldTaps(output.node as unknown as TslNode);
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
        right = this.albedoTexture ? texture(this.albedoTexture, screenUV) : vec4(this.scenePass.getTextureNode('albedo').rgb, 1);
        break;
      case SplitView.Baked:
        right = vec4(this.bakedIndirectNode(), 1);
        break;
      case SplitView.Normal:
        right = vec4(
          this.scenePass.getTextureNode('normal').rgb.mul(0.5).add(0.5),
          1,
        );
        break;
      case SplitView.Contact:
        if (this.contact) right = vec4(vec3((this.contact.sample(screenUV as unknown as TslNode) as ReturnType<typeof vec4>).z), 1);
        break;
      case SplitView.BentNormal:
        if (this.contact) {
          const c = this.contact.sample(screenUV as unknown as TslNode) as ReturnType<typeof vec4>;
          right = vec4(octDecode(c.xy as ReturnType<typeof vec2>).mul(0.5).add(0.5), 1);
        }
        break;
      case SplitView.Reflections:
        if (this.reflections) right = vec4((this.reflections.sample(screenUV as unknown as TslNode) as ReturnType<typeof vec4>).rgb, 1);
        break;
      case SplitView.Leak:
        if (this.leakTexture) right = vec4(texture(this.leakTexture, this.paneSquareUv()).rgb, 1);
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

  private paneSquareUv() {
    return vec2(screenUV.x.sub(this.splitPosition).div(1 - this.splitPosition), screenUV.y);
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

  /**
   * Jitter the camera for this frame. Call before anything renders with it — the GI's
   * G-buffer and the fog read the same projection — and pair with `endFrame()`.
   */
  beginFrame(): void {
    // Motion-vector matrices for vertex-animated materials and the cut detection, in
    // every AA mode; before the jitter, which must not enter the unjittered matrices.
    this.taa.trackCamera();
    if (this.antialiasing === 'taa') {
      this.renderer.getDrawingBufferSize(frameSize);
      this.taa.beginFrame(frameSize.width, frameSize.height);
    }
  }

  endFrame(): void {
    this.taa.endFrame();
  }

  /**
   * An `rtt()` renders once per `NodeFrame.frameId`, but that id advances on every
   * nested `renderer.render()` — the TAA's resolve quad and the bloom chain included
   * — so a copy read after one of those found a "new frame" and re-rendered the whole
   * composite into it. Measured 2026-09-08 with scripts/_render_calls_probe.mjs: the
   * pre-overlay copy of the composite rendered twice a frame, 0.45 ms each at 4K.
   * These render once per FrameGraph.render() instead.
   */
  private copyOncePerFrame<T extends { updateBefore(frame: THREE.NodeFrame): void; renderTarget: THREE.RenderTarget | null }>(node: T, name: string): T {
    if (node.renderTarget) node.renderTarget.texture.name = name;
    const original = node.updateBefore.bind(node);
    let renderedSerial = -1;
    node.updateBefore = (frame: THREE.NodeFrame) => {
      if (renderedSerial === this.frameSerial) return;
      renderedSerial = this.frameSerial;
      original(frame);
    };
    return node;
  }

  render(): void {
    this.frameSerial++;
    if (this.motionBlur) {
      this.renderer.getDrawingBufferSize(frameSize);
      this.motionBlur.update(this.renderer, this.scenePass.getTexture('velocity'), this.scenePass.getTexture('depth'), frameSize.width, frameSize.height, this.taa.cut);
    }
    if (this.needsComposite) this.rebuildComposite();
    this.frameIndex.value = (this.frameIndex.value + 1) % 4096;
    if (this.overlayCamera) {
      // Same eye, same lens, one layer: `copy` takes the layers with it, so reset them.
      this.overlayCamera.copy(this.camera, false);
      this.overlayCamera.layers.set(Layer.Overlay);
      this.overlayCamera.updateMatrixWorld();
    }
    this.post.render();
  }
}
