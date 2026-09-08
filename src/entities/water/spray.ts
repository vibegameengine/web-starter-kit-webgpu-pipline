import * as THREE from 'three/webgpu';
import {
  Fn,
  Discard,
  cameraWorldMatrix,
  clamp,
  float,
  fract,
  instanceIndex,
  length,
  max,
  mix,
  mrt,
  perspectiveDepthToViewZ,
  cameraNear,
  cameraFar,
  positionLocal,
  positionView,
  screenUV,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

/**
 * Spray: where the water hits a boulder faster than it can climb it, the flow's
 * energy leaves the sheet as droplets (grill Q37, and the user: "энергия переходит
 * и в пену, и в брызги"). A pool of particles lives in two ping-pong textures
 * (position + life, velocity + seed); each frame one quad pass advances the living
 * ones under gravity and lets a dead one try one random spot of the impact field
 * (foam field, B channel) — a hit launches it from the surface with the flow's
 * horizontal speed and an upward kick scaled by the impact. Rendered as premultiplied
 * white billboards on the overlay layer, occluded by the scene depth and by the
 * surface itself.
 */
export interface SprayOptions {
  renderer: THREE.WebGPURenderer;
  half: number;
  waterLevel: number;
  /** Foam field over the slab: B = impact source (0..1). */
  foamField: ReturnType<typeof texture>;
  /** Solver view: (depth, u, v, ·) over the slab. */
  simState: ReturnType<typeof texture>;
  /** Surface field: R = η − level. */
  surface: ReturnType<typeof texture>;
  /** Unit vector toward the sun, and its irradiance (colour × intensity). */
  sunDir: ReturnType<typeof uniform>;
  sunColor: ReturnType<typeof uniform>;
  count?: number;
  /** `?sprayTest=1`: droplets spawn everywhere over the water; `2`: billboards on a fixed grid, no state at all. */
  test?: number;
}

export class Spray {
  readonly mesh: THREE.InstancedMesh;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly side: number;
  private posRead: THREE.RenderTarget;
  private posWrite: THREE.RenderTarget;
  private readonly posPrev: ReturnType<typeof texture>;
  private readonly velPrev: ReturnType<typeof texture>;
  private readonly posNode: ReturnType<typeof texture>;
  private readonly dt = uniform(1 / 60);
  private readonly seed = uniform(0);
  private readonly screenDepth: ReturnType<typeof texture>;
  private readonly quad: THREE.QuadMesh;
  private initialised = false;
  private frame = 0;

  constructor(options: SprayOptions) {
    const { renderer, half, waterLevel, foamField, simState, surface, sunDir, sunColor, count = 4096, test = 0 } = options;
    this.renderer = renderer;
    const side = Math.ceil(Math.sqrt(count));
    this.side = side;
    const makeTarget = () => {
      const target = new THREE.RenderTarget(side, side, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        count: 2,
        depthBuffer: false,
        generateMipmaps: false,
      });
      target.textures[0].name = 'position';
      target.textures[1].name = 'velocity';
      for (const tex of target.textures) {
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      }
      return target;
    };
    this.posRead = makeTarget();
    this.posWrite = makeTarget();
    this.posPrev = texture(this.posRead.textures[0]);
    this.velPrev = texture(this.posRead.textures[1]);
    this.posNode = texture(this.posRead.textures[0]);
    this.screenDepth = texture(new THREE.DepthTexture(1, 1));

    const level = uniform(waterLevel);
    const slabHalf = uniform(half);
    type V2 = ReturnType<typeof vec2>;
    type V3 = ReturnType<typeof vec3>;
    type F = ReturnType<typeof float>;

    // --- update: one texel per particle -------------------------------------------
    const material = new THREE.MeshBasicNodeMaterial();
    material.name = 'sprayUpdate';
    material.transparent = false;
    material.blending = THREE.NoBlending;
    material.depthTest = false;
    material.depthWrite = false;
    material.toneMapped = false;
    const hash = (x: F, y: F): F => fract(sin(x.mul(127.1).add(y.mul(311.7))).mul(43758.5453)) as unknown as F;
    // Plain node graph (no control flow): one texel per particle, two attachments.
    {
      const q = uv();
      const posLife = this.posPrev.sample(q);
      const velSeed = this.velPrev.sample(q);
      const alive = posLife.w.greaterThan(0.0);
      const dt = this.dt;
      // Living: ballistic, dies below the surface or at the end of its life.
      const vel = vec3(velSeed.x, velSeed.y.sub(float(9.81).mul(dt)), velSeed.z);
      const pos = posLife.xyz.add(vel.mul(dt));
      const surfUv = pos.xz.div(slabHalf.mul(2.0)).add(0.5) as unknown as V2;
      const eta = level.add(surface.sample(surfUv).r);
      const lifeNext = posLife.w.sub(dt).mul(step(eta.sub(0.005), pos.y));
      // Dead: try one random spot of the impact field this frame.
      const id = q.x.mul(this.side).floor().add(q.y.mul(this.side).floor().mul(this.side));
      const r1 = hash(id, this.seed);
      const r2 = hash(id.add(17.0), this.seed.add(3.0));
      const r3 = hash(id.add(41.0), this.seed.add(7.0));
      // Two candidate spots per frame; the stronger source wins. Spray comes from an
      // impact on a boulder (foam field B) and, weaker, from a breaking bore (view A).
      const sourceAt = (u: V2): F => {
        const f = foamField.sample(u);
        const v = simState.sample(u);
        // A breaking bore throws spray only over real water, not the swash on the sand.
        const breaking = smoothstep(0.6, 1.0, v.a).mul(smoothstep(0.3, 1.0, length(v.gb))).mul(smoothstep(0.06, 0.15, v.r)).mul(0.5);
        const s = max(f.b, breaking);
        return (test >= 1 ? v.r.greaterThan(0.05).select(float(0.3), float(0.0)) : s) as unknown as F;
      };
      const tryA = vec2(r1, r2) as unknown as V2;
      const tryB = vec2(hash(id.add(23.0), this.seed.add(19.0)), hash(id.add(29.0), this.seed.add(23.0))) as unknown as V2;
      const sourceA = sourceAt(tryA);
      const sourceB = sourceAt(tryB);
      const useB = sourceB.greaterThan(sourceA);
      const tryUv = select(useB, tryB, tryA) as unknown as V2;
      const source = select(useB, sourceB, sourceA) as unknown as F;
      const flow = simState.sample(tryUv);
      const spawn = source.mul(r3.add(0.5)).greaterThan(0.12);
      const tryXz = tryUv.sub(0.5).mul(2.0).mul(slabHalf);
      const kick = float(1.5).add(source.mul(3.0)).mul(float(0.6).add(r3.mul(0.8)));
      const spread = vec2(hash(id.add(5.0), this.seed.add(11.0)).sub(0.5), hash(id.add(9.0), this.seed.add(13.0)).sub(0.5)).mul(1.6);
      const spawnPos = vec3(tryXz.x, level.add(surface.sample(tryUv).r).add(0.03), tryXz.y);
      const spawnVel = vec3(flow.g.mul(0.6).add(spread.x), kick, flow.b.mul(0.6).add(spread.y));
      const spawnLife = float(0.5).add(r1.mul(0.7));
      const posOut = select(alive, vec4(pos, lifeNext), select(spawn, vec4(spawnPos, spawnLife), vec4(0.0, -10.0, 0.0, 0.0)));
      const velOut = select(alive, vec4(vel, velSeed.w), select(spawn, vec4(spawnVel, r3), vec4(0.0)));
      // MRT entries other than `output` are written raw (no colour chain, no clamp).
      material.mrtNode = mrt({ position: posOut, velocity: velOut });
      material.colorNode = vec4(0.0);
    }
    this.quad = new THREE.QuadMesh(material);
    void sqrt;

    // --- render: premultiplied white billboards --------------------------------------
    const geometry = new THREE.PlaneGeometry(1, 1);
    const sprite = new THREE.MeshBasicNodeMaterial();
    sprite.name = 'sprayDroplets';
    sprite.transparent = true;
    sprite.premultipliedAlpha = true;
    sprite.depthWrite = false;
    sprite.depthTest = true;
    sprite.side = THREE.DoubleSide;
    sprite.toneMapped = true;
    const texel = float(1 / side);
    const particleUv = vec2(instanceIndex.mod(side).toFloat().add(0.5).mul(texel), instanceIndex.div(side).toFloat().add(0.5).mul(texel)) as unknown as V2;
    const stored = this.posNode.sample(particleUv);
    // Test 2: a fixed grid of droplets 10 cm over the still-water line, no state read.
    const gridPos = vec3(particleUv.x.sub(0.5).mul(2.0).mul(slabHalf), level.add(0.1), particleUv.y.sub(0.5).mul(2.0).mul(slabHalf));
    const state = test === 2 ? vec4(gridPos, 0.5) : stored;
    const life = state.w;
    const right = cameraWorldMatrix.mul(vec4(1.0, 0.0, 0.0, 0.0)).xyz as unknown as V3;
    const up = cameraWorldMatrix.mul(vec4(0.0, 1.0, 0.0, 0.0)).xyz as unknown as V3;
    // Droplet size: a couple of centimetres, growing a little as it breaks up.
    const size = float(0.035).add(float(1.2).sub(life).mul(0.03)).mul(step(0.0001, life));
    sprite.positionNode = state.xyz.add(right.mul(positionLocal.x.mul(size))).add(up.mul(positionLocal.y.mul(size)));
    const disc = smoothstep(0.5, 0.05, length(uv().sub(0.5)));
    const fade = smoothstep(0.0, 0.15, life).mul(smoothstep(1.2, 0.7, life));
    const lit = vec3(sunColor).mul(clamp(vec3(sunDir).y, 0.0, 1.0)).mul(0.5).add(vec3(0.6, 0.65, 0.7));
    sprite.colorNode = lit;
    sprite.opacityNode = disc.mul(fade).mul(0.7);
    // Occluded by whatever the scene drew there.
    const sceneZ = perspectiveDepthToViewZ(this.screenDepth.sample(screenUV).x, cameraNear, cameraFar);
    sprite.fragmentNode = Fn(() => {
      Discard(positionView.z.lessThan(sceneZ.sub(0.01)).or(life.lessThan(0.0001)));
      const a = disc.mul(fade).mul(0.7);
      return vec4(mix(vec3(0.0), lit, a), a);
    })();
    this.mesh = new THREE.InstancedMesh(geometry, sprite, side * side);
    this.mesh.name = 'spray';
    this.mesh.frustumCulled = false;
  }

  /** How many droplets are alive, and where the first few are (debugging). */
  async readStats(): Promise<{ alive: number; sample: number[][] }> {
    const side = this.side;
    const raw = await this.renderer.readRenderTargetPixelsAsync(this.posRead, 0, 0, side, side, 0);
    const decode = raw instanceof Uint16Array ? (x: number) => THREE.DataUtils.fromHalfFloat(x) : (x: number) => x;
    let alive = 0;
    const sample: number[][] = [];
    for (let i = 0; i < side * side; i++) {
      const life = decode(raw[i * 4 + 3]);
      if (life > 0) {
        alive++;
        if (sample.length < 4) sample.push([decode(raw[i * 4]), decode(raw[i * 4 + 1]), decode(raw[i * 4 + 2]), life].map((v) => Number(v.toFixed(3))));
      }
    }
    return { alive, sample };
  }

  /** The scene depth the frame graph renders; droplets behind it are discarded. */
  bindDepth(depth: THREE.Texture): void {
    this.screenDepth.value = depth;
  }

  update(dt: number): void {
    const renderer = this.renderer;
    const previous = renderer.getRenderTarget();
    if (!this.initialised) {
      // Everything starts dead: a clear to zero life.
      renderer.setRenderTarget(this.posRead);
      renderer.clear();
      this.initialised = true;
    }
    this.dt.value = Math.min(0.05, Math.max(0.001, dt));
    this.seed.value = (this.frame++ % 1000) * 0.37;
    this.posPrev.value = this.posRead.textures[0];
    this.velPrev.value = this.posRead.textures[1];
    renderer.setRenderTarget(this.posWrite);
    this.quad.render(renderer);
    const swap = this.posRead;
    this.posRead = this.posWrite;
    this.posWrite = swap;
    this.posNode.value = this.posRead.textures[0];
    renderer.setRenderTarget(previous);
  }
}
