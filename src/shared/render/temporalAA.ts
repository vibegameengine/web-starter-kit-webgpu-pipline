import * as THREE from 'three/webgpu';
import {
  passTexture,
  Fn,
  If,
  abs,
  clamp,
  float,
  ivec2,
  max,
  mix,
  sqrt,
  texture,
  textureLoad,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  velocity,
} from 'three/tsl';
import { U_PREVIOUS_VIEW_PROJECTION, U_VIEW_PROJECTION } from './vertexMotion.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Halton (2, 3) subpixel offsets in [0, 1), the 8-sample cycle most TAA resolves use. */
function halton(index: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}
const JITTER: Array<[number, number]> = Array.from({ length: 8 }, (_, i) => [halton(i + 1, 2), halton(i + 1, 3)]);

const quad = new THREE.QuadMesh();
const drawingSize = new THREE.Vector2();

/**
 * Temporal anti-aliasing / accumulation, written for this frame graph rather than
 * taken from an addon so the fog, the soft shadows, the coming contact occlusion and
 * reflections can all lean on it and its rules are ours to change.
 *
 * Per frame:
 *  - the scene camera is jittered by a Halton(2,3) subpixel offset (`beginFrame`,
 *    before anything renders — the GI's G-buffer, the fog and the overlay water all
 *    read the same jittered projection); the velocity node keeps the unjittered
 *    projection so motion vectors carry no jitter;
 *  - the resolve reprojects the previous history with the velocity of the *closest*
 *    pixel in a 3x3 depth neighbourhood (velocity dilation, so thin foreground edges
 *    drag their history with them), samples it with a 9-tap Catmull-Rom (no bilinear
 *    smear), and clips it to the current frame's 3x3 YCoCg mean ± γ·σ (variance
 *    clipping) so stale colour cannot ghost;
 *  - the blend weight is 1/(1 + luma) on both inputs (Karis) so bright fireflies do
 *    not flicker, raised toward 1 when the history left the screen, and raised with
 *    the pixel speed so fast motion shows the current frame rather than smear.
 *
 * Output is the resolved history, a full-resolution RGBA16F. The history is kept in
 * a second target and refreshed by a copy after each resolve so the output texture
 * keeps its identity across frames (a ping-pong would change what the composite
 * samples every frame).
 *
 * The plumbing (frame-typed update, quad resolve into a target, copy to history,
 * `passTexture` output) follows three's TRAANode, which was read line by line for
 * this. Its `RendererUtils.resetRendererState` guard is deliberately *not* used: with
 * it the resolve came out black in this frame graph (bisected 2026-09-08), and the
 * post-processing quad leaves no state that needs guarding here. The resolve differs: YCoCg variance clipping instead of
 * an RGB min/max box, Catmull-Rom instead of bilinear history, Karis weighting, and the
 * jitter applied at the top of the frame rather than inside post-processing so the
 * GI's G-buffer and the fog render with the same projection. Not carried over yet:
 * three's depth-history disocclusion test.
 */
export class TemporalAANode extends THREE.TempNode {
  /** History weight for a still pixel; 0.9 = ten-frame convergence. */
  readonly historyWeight = uniform(0.9);
  /**
   * The current frame is sampled at the unjittered position (resampled by −jitter), so
   * what the blend adds each frame is the same scene point, not the jitter's wobble.
   * Sign of that offset; 0 (default) reads the raw texel: measured 2026-09-08 with
   * `scripts/_taa_unjitter_probe.mjs`, neither sign beat the raw texel, so the resample
   * stays available (`?taaUnjitter=1|-1`) but off.
   */
  readonly unjitterSign = uniform(0);
  /** Control for the bisection: 1 = the old copy-to-history path (history one frame late). */
  copyMode = 0;
  private readonly uJitter = uniform(new THREE.Vector2());
  /** Variance-clip width in standard deviations. 1.0 tight, 1.5 loose. */
  readonly clipGamma = uniform(1.25);
  /** Pixel speed at which the history weight has fallen to `motionWeight`. */
  readonly motionPixels = uniform(24);
  readonly motionWeight = uniform(0.5);

  /** Two targets, ping-pong: the frame resolves into one while reading the other. */
  private readonly targets: [THREE.RenderTarget, THREE.RenderTarget];
  /** One resolve material per parity, each bound to a fixed history texture: no per-frame rebinding. */
  private readonly resolveMaterials: [THREE.NodeMaterial, THREE.NodeMaterial];
  private parity = 0;
  /** 0/1: which target holds this frame's resolve; the composite selects by it. */
  private readonly uOutputParity = uniform(0);
  private readonly textureNode: THREE.Node;
  private readonly texelSize = uniform(new THREE.Vector2(1 / 1600, 1 / 900));
  private readonly historyValid = uniform(0);
  private readonly originalProjection = new THREE.Matrix4();
  private readonly previousView = new THREE.Matrix4();
  private hasPreviousView = false;
  private jitterIndex = 0;
  private jittered = false;
  private historyReady = false;

  constructor(
    /** An `rtt()` of the frame to accumulate: the resolve loads its texels directly. */
    private inputNode: N,
    private readonly depthNode: N,
    private readonly velocityNode: N,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    super('vec4');
    this.updateBeforeType = THREE.NodeUpdateType.FRAME;
    const make = (name: string) => {
      const rt = new THREE.RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType });
      rt.texture.name = name;
      rt.texture.minFilter = THREE.LinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
      return rt;
    };
    this.targets = [make('TAA.a'), make('TAA.b')];
    this.resolveMaterials = [new THREE.NodeMaterial(), new THREE.NodeMaterial()];
    this.resolveMaterials[0].name = 'TAA.resolve.a';
    this.resolveMaterials[1].name = 'TAA.resolve.b';
    // Both targets stay bound in the composite; a uniform picks this frame's. Swapping
    // a texture node's value each frame lagged a frame behind the bind group and the
    // history was read from the target being written (bimodal: some boots resolved,
    // most did not — measured 2026-09-08 with scripts/_taa_steps_probe.mjs).
    // `passTexture(this, …)` is what makes the node part of the graph so `updateBefore`
    // runs at all; without it the resolve never rendered and the frame was black.
    this.textureNode = this.uOutputParity.lessThan(0.5).select(
      passTexture(this as unknown as THREE.PassNode, this.targets[0].texture),
      texture(this.targets[1].texture),
    ) as unknown as THREE.Node;
  }

  /** Last frame's resolved colour — what a reflection ray reads when it lands on screen. */
  get historyTexture(): THREE.Texture {
    return this.targets[1 - this.parity].texture;
  }

  /**
   * The most recent resolve. `updateBefore` flips the parity after writing, so between
   * frames (where an audit reads this) the latest frame sits in `targets[1 - parity]`,
   * the same texture `historyTexture` names for the next frame's readers.
   */
  get resolvedTexture(): THREE.Texture {
    return this.targets[1 - this.parity].texture;
  }

  /** The frame being accumulated (the composed beauty the resolve reads), for audits. */
  get inputTexture(): THREE.Texture | null {
    return this.inputNode?.value ?? null;
  }

  /** Replaces the frame being accumulated (composite rebuilt); history is kept. */
  setInput(node: N): void {
    this.inputNode = node;
    this.buildMaterials();
  }

  getTextureNode(): THREE.Node {
    return this.textureNode;
  }

  /**
   * Jitters the scene camera for this frame. Call once at the top of the frame, after
   * the camera's matrices are current and before any pass renders with it.
   */
  beginFrame(width: number, height: number): void {
    const cam = this.camera;
    // A cut: the eye moved farther in one frame than any motion this scene has (a
    // metre) or turned more than ~25°. Reprojection has nothing valid to offer then;
    // drop the history rather than clip it toward the new frame and show a ghost.
    if (this.hasPreviousView) {
      const e = cam.matrixWorld.elements, p = this.previousView.elements;
      const dx = e[12] - p[12], dy = e[13] - p[13], dz = e[14] - p[14];
      // Third column of matrixWorld is the camera's own +z axis; its dot with last
      // frame's is the cosine of the turn.
      const turnCos = e[8] * p[8] + e[9] * p[9] + e[10] * p[10];
      if (dx * dx + dy * dy + dz * dz > 1 || turnCos < Math.cos(THREE.MathUtils.degToRad(25))) this.historyReady = false;
    }
    this.previousView.copy(cam.matrixWorld);
    this.hasPreviousView = true;
    cam.updateProjectionMatrix();
    this.originalProjection.copy(cam.projectionMatrix);
    velocity.setProjectionMatrix(this.originalProjection);
    const [jx, jy] = JITTER[this.jitterIndex];
    this.uJitter.value.set(jx - 0.5, jy - 0.5);
    this.lastWidth = width;
    this.lastHeight = height;
    cam.setViewOffset(width, height, jx - 0.5, jy - 0.5, width, height);
    this.jittered = true;
  }

  /**
   * Publishes the unjittered view-projection of this frame and keeps last frame's,
   * for materials that compute their own motion vectors (vertexMotion.ts). Call every
   * frame after the camera's matrices are current, whatever the AA mode.
   */
  trackCamera(): void {
    const cam = this.camera;
    U_PREVIOUS_VIEW_PROJECTION.value.copy(U_VIEW_PROJECTION.value);
    const wasJittered = this.jittered;
    if (wasJittered) cam.clearViewOffset();
    cam.updateProjectionMatrix();
    U_VIEW_PROJECTION.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    if (wasJittered) {
      const [jx, jy] = JITTER[this.jitterIndex];
      cam.setViewOffset(this.lastWidth, this.lastHeight, jx - 0.5, jy - 0.5, this.lastWidth, this.lastHeight);
    }
  }
  private lastWidth = 1;
  private lastHeight = 1;

  /** Restores the camera after the frame rendered. */
  endFrame(): void {
    if (!this.jittered) return;
    this.camera.clearViewOffset();
    velocity.setProjectionMatrix(null);
    this.jitterIndex = (this.jitterIndex + 1) % JITTER.length;
    this.jittered = false;
  }

  /** Audit: what the resolve was told this frame. */
  get state(): { historyReady: boolean; historyValid: number; parity: number; jitter: number[]; weight: number } {
    return { historyReady: this.historyReady, historyValid: this.historyValid.value, parity: this.parity, jitter: [this.uJitter.value.x, this.uJitter.value.y], weight: this.historyWeight.value };
  }

  /** Drops the accumulated history (camera cut). */
  reset(): void {
    this.historyReady = false;
  }

  setSize(width: number, height: number): void {
    if (this.targets[0].width === width && this.targets[0].height === height) return;
    this.targets[0].setSize(width, height);
    this.targets[1].setSize(width, height);
    this.texelSize.value.set(1 / width, 1 / height);
    this.historyReady = false;
  }

  override updateBefore(frame: THREE.NodeFrame): void {
    const renderer = frame.renderer as THREE.WebGPURenderer;
    renderer.getDrawingBufferSize(drawingSize);
    this.setSize(drawingSize.width, drawingSize.height);

    const previousTarget = renderer.getRenderTarget();
    this.historyValid.value = this.historyReady ? 1 : 0;
    // Ping-pong instead of a copy: `copyTextureToTexture` submits its own command
    // buffer at once, ahead of a render recorded inside another render, so the copy
    // took last frame's resolve and the history ran a frame late — two solutions
    // alternating, a wobble on every thin edge (bisected 2026-09-08).
    // `copyMode` keeps the old behaviour reachable for the check's control: resolve
    // into A, copy A into B, always read B.
    const write = this.copyMode ? this.targets[0] : this.targets[this.parity];
    const read = this.copyMode ? this.targets[1] : this.targets[1 - this.parity];
    if (!this.historyReady) {
      renderer.setRenderTarget(read);
      renderer.clear();
    }
    renderer.setRenderTarget(write);
    // Material `parity` reads targets[1 - parity] as history; in copy mode material 0
    // reads targets[1], which the copy refreshes.
    quad.material = this.resolveMaterials[this.copyMode ? 0 : this.parity];
    quad.name = 'TAA';
    quad.render(renderer);
    renderer.setRenderTarget(previousTarget);
    this.uOutputParity.value = this.copyMode ? 0 : this.parity;
    if (this.copyMode) renderer.copyTextureToTexture(write.texture, read.texture);
    else this.parity = 1 - this.parity;
    this.historyReady = true;
  }

  override setup(): THREE.Node {
    this.buildMaterials();
    return this.textureNode;
  }

  /** Builds the two resolve materials (history from target B for material A, and vice versa). */
  private buildMaterials(): void {
    if (!this.inputNode) return;
    for (let p = 0; p < 2; p++) {
      this.resolveMaterials[p].fragmentNode = this.buildResolve(this.inputNode, texture(this.targets[1 - p].texture));
      this.resolveMaterials[p].needsUpdate = true;
    }
  }

  private buildResolve(inputNode: N, historyNode: N): N {
    const current = inputNode;
    const depth = this.depthNode;
    const motion = this.velocityNode;
    const texel = this.texelSize;
    const size = vec2(1).div(texel);

    const toYCoCg = (c: N) => vec3(
      c.r.mul(0.25).add(c.g.mul(0.5)).add(c.b.mul(0.25)),
      c.r.mul(0.5).sub(c.b.mul(0.5)),
      c.r.mul(-0.25).add(c.g.mul(0.5)).sub(c.b.mul(0.25)),
    );
    const fromYCoCg = (c: N) => vec3(
      c.x.add(c.y).sub(c.z),
      c.x.add(c.z),
      c.x.sub(c.y).sub(c.z),
    );
    const loadCurrent = (px: N) => vec3(textureLoad(current.value, px).rgb);
    const loadDepth = (px: N) => textureLoad(depth.value, px).r;
    // The RTT node itself has to sit in this material's graph, or it is never rendered.
    // The centre sample is taken at the unjittered position: the camera drew this frame
    // offset by `uJitter` texels, so resampling by the opposite offset lands the
    // same scene point every frame and the blend stops carrying the jitter.
    const unjitterUv = uv().add(this.uJitter.mul(texel).mul(this.unjitterSign));
    const centreSample = vec3(current.sample(unjitterUv).rgb);

    // Catmull-Rom 9-tap history fetch on the bilinear sampler (Jimenez 2016, 5 taps
    // would drop the corners; the full 9 keeps the reconstruction symmetric).
    const catmullRom = Fn(([sampleUv]: [N]) => {
      const position = sampleUv.mul(size);
      const centre = position.sub(0.5).floor().add(0.5);
      const f = position.sub(centre);
      const w0 = f.mul(f.mul(f.mul(-0.5).add(1.0)).sub(0.5));
      const w1 = f.mul(f).mul(f.mul(1.5).sub(2.5)).add(1.0);
      const w2 = f.mul(f.mul(f.mul(-1.5).add(2.0)).add(0.5));
      const w3 = f.mul(f).mul(f.mul(0.5).sub(0.5));
      const w12 = w1.add(w2);
      const offset12 = w2.div(w12);
      const tc0 = centre.sub(1).mul(texel);
      const tc3 = centre.add(2).mul(texel);
      const tc12 = centre.add(offset12).mul(texel);
      const tap = (x: N, y: N, w: N) => historyNode.sample(vec2(x, y)).rgb.mul(w);
      const sum = vec3(0).toVar();
      sum.addAssign(tap(tc0.x, tc0.y, w0.x.mul(w0.y)));
      sum.addAssign(tap(tc12.x, tc0.y, w12.x.mul(w0.y)));
      sum.addAssign(tap(tc3.x, tc0.y, w3.x.mul(w0.y)));
      sum.addAssign(tap(tc0.x, tc12.y, w0.x.mul(w12.y)));
      sum.addAssign(tap(tc12.x, tc12.y, w12.x.mul(w12.y)));
      sum.addAssign(tap(tc3.x, tc12.y, w3.x.mul(w12.y)));
      sum.addAssign(tap(tc0.x, tc3.y, w0.x.mul(w3.y)));
      sum.addAssign(tap(tc12.x, tc3.y, w12.x.mul(w3.y)));
      sum.addAssign(tap(tc3.x, tc3.y, w3.x.mul(w3.y)));
      // The negative lobes can undershoot on high contrast; the clip below bounds it.
      return max(sum, vec3(0));
    });

    const resolve = Fn(() => {
      const fragUv = uv();
      const px = ivec2(fragUv.mul(size)).toVar();
      const maxPx = ivec2(size.sub(1));

      // --- current 3x3: mean/variance in YCoCg, and the closest-depth texel ---------
      const m1 = vec3(0).toVar();
      const m2 = vec3(0).toVar();
      const closestDepth = float(2).toVar();
      const closestPx = px.toVar();
      const centreColor = vec3(0).toVar();
      for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
        const p = clamp(px.add(ivec2(x, y)), ivec2(0), maxPx);
        const c = toYCoCg(x === 0 && y === 0 ? centreSample : loadCurrent(p));
        m1.addAssign(c);
        m2.addAssign(c.mul(c));
        if (x === 0 && y === 0) centreColor.assign(c);
        const d = loadDepth(p);
        If(d.lessThan(closestDepth), () => {
          closestDepth.assign(d);
          closestPx.assign(p);
        });
      }
      const mean = m1.div(9);
      const variance = max(m2.div(9).sub(mean.mul(mean)), vec3(0));
      const sigma = sqrt(variance).mul(this.clipGamma);
      const boxMin = mean.sub(sigma);
      const boxMax = mean.add(sigma);

      // --- reproject with the dilated velocity ---------------------------------
      // three's velocity is an NDC delta (current − previous); NDC y is up, texture v
      // is down, hence the sign on y.
      const ndcDelta = textureLoad(motion.value, closestPx).xy;
      const uvDelta = vec2(ndcDelta.x.mul(0.5), ndcDelta.y.mul(-0.5));
      const prevUv = fragUv.sub(uvDelta);
      const onScreen = prevUv.x.greaterThanEqual(0).and(prevUv.x.lessThanEqual(1))
        .and(prevUv.y.greaterThanEqual(0)).and(prevUv.y.lessThanEqual(1));
      const historyRgb = catmullRom(prevUv);
      const historyY = toYCoCg(historyRgb);

      // --- clip the history into the current neighbourhood's box ------------------
      // Clip toward the box centre along the segment from the history sample (AABB
      // clipping, not clamping, so colour direction is preserved).
      const centre = boxMin.add(boxMax).mul(0.5);
      const extent = boxMax.sub(boxMin).mul(0.5).add(1e-5);
      const offset = historyY.sub(centre);
      const unit = abs(offset.div(extent));
      const maxUnit = max(unit.x, max(unit.y, unit.z));
      const clipped = maxUnit.greaterThan(1).select(centre.add(offset.div(maxUnit)), historyY);

      // --- blend --------------------------------------------------------------------
      const speed = uvDelta.mul(size).length();
      const motionFactor = clamp(speed.div(this.motionPixels), 0, 1);
      let weight: N = mix(this.historyWeight, this.motionWeight, motionFactor);
      weight = weight.mul(onScreen.select(float(1), float(0))).mul(this.historyValid);
      // Karis: weigh both inputs by 1/(1+luma) so a bright transient does not flicker.
      const wCurrent = float(1).sub(weight).div(float(1).add(centreColor.x));
      const wHistory = weight.div(float(1).add(clipped.x));
      const resolved = centreColor.mul(wCurrent).add(clipped.mul(wHistory)).div(wCurrent.add(wHistory));
      return vec4(max(fromYCoCg(resolved), vec3(0)), 1);
    });

    return resolve();
  }

  dispose(): void {
    this.targets[0].dispose();
    this.targets[1].dispose();
    this.resolveMaterials[0].dispose();
    this.resolveMaterials[1].dispose();
  }
}

export const temporalAA = (input: N, depth: N, motion: N, camera: THREE.PerspectiveCamera) =>
  new TemporalAANode(input, depth, motion, camera);

