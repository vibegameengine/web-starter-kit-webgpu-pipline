import * as THREE from 'three/webgpu';
import {
  Fn,
  Discard,
  cameraNear,
  cameraFar,
  cameraViewMatrix,
  cameraWorldMatrix,
  clamp,
  dot,
  float,
  fract,
  instanceIndex,
  length,
  max,
  min,
  mix,
  mrt,
  normalize,
  perspectiveDepthToViewZ,
  positionLocal,
  positionView,
  pow,
  screenUV,
  select,
  sin,
  smoothstep,
  sqrt,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

/**
 * Spray, by the physics of a wave hitting a wall.
 *
 * Where the flow is driven into a steep rise of the bed faster than it can climb it,
 * it stagnates: the kinetic head u²/2g becomes a vertical jet, and for a wave front
 * meeting a wall the jet stands 1.5–3× higher than that (the "flip-through" of a
 * plunging or near-breaking impact). The jet is a sheet that thins and, by the
 * Rayleigh–Plateau instability, breaks into droplets of a fraction of a millimetre to
 * a few millimetres, skewed to small. Each droplet is then a ballistic body under
 * gravity and aerodynamic drag, a = −(3 ρ_air C_d / 8 ρ_water r)·|v|·v, so the small
 * ones lose their speed within a fraction of a metre and hang as mist while the large
 * ones fly. At the foot of the impact the water is aerated white: that goes into the
 * foam field, not here.
 *
 * Emission is proportional to the kinetic energy flux h·u³ arriving at the impact,
 * which the foam field's impact channel carries. The pool lives in two ping-pong
 * textures (position + age, velocity + radius); one quad pass per frame advances the
 * living droplets and lets each dead one try two spots of the impact field.
 *
 * A droplet is drawn as what it is: a small lens. Its sprite is stretched along the
 * velocity (what an eye or a shutter integrates), shows the scene behind it refracted
 * (the screen colour, offset by the lens), a Fresnel rim and the sun's glint. Mist is
 * the same particles at their smallest radius, drawn larger and fainter.
 */
export interface SprayOptions {
  renderer: THREE.WebGPURenderer;
  half: number;
  waterLevel: number;
  /** Foam field over the slab: B = impact source (0..1). */
  foamField: ReturnType<typeof texture>;
  /** Solver view: (depth, u, v, foam source) over the slab. */
  simState: ReturnType<typeof texture>;
  /** Surface field: R = η − level. */
  surface: ReturnType<typeof texture>;
  /** Unit vector toward the sun, and its irradiance (colour × intensity). */
  sunDir: ReturnType<typeof uniform>;
  sunColor: ReturnType<typeof uniform>;
  count?: number;
  /** `?sprayTest=1`: droplets spawn everywhere over the water; `2`: billboards on a fixed grid, no state; `3`: no depth test. */
  test?: number;
}

const GRAVITY = 9.81;
/** 3·ρ_air·C_d / (8·ρ_water): drag acceleration = DRAG·|v|·v / r, with C_d ≈ 0.5 for a sphere. */
const DRAG = (3 * 1.2 * 0.5) / (8 * 1000);

export class Spray {
  readonly mesh: THREE.InstancedMesh;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly side: number;
  private posRead: THREE.RenderTarget;
  private posWrite: THREE.RenderTarget;
  private readonly posPrev: ReturnType<typeof texture>;
  private readonly velPrev: ReturnType<typeof texture>;
  private readonly posNode: ReturnType<typeof texture>;
  private readonly velNode: ReturnType<typeof texture>;
  private readonly dt = uniform(1 / 60);
  private readonly seed = uniform(0);
  private readonly screenDepth: ReturnType<typeof texture>;
  private readonly screenColor: ReturnType<typeof texture>;
  private readonly quad: THREE.QuadMesh;
  private initialised = false;
  private frame = 0;

  constructor(options: SprayOptions) {
    const { renderer, half, waterLevel, foamField, simState, surface, sunDir, sunColor, count = 16384, test = 0 } = options;
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
    this.velNode = texture(this.posRead.textures[1]);
    this.screenDepth = texture(new THREE.DepthTexture(1, 1));
    const placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    placeholder.needsUpdate = true;
    this.screenColor = texture(placeholder);

    const level = uniform(waterLevel);
    const slabHalf = uniform(half);
    type V2 = ReturnType<typeof vec2>;
    type V3 = ReturnType<typeof vec3>;
    type V4 = ReturnType<typeof vec4>;
    type F = ReturnType<typeof float>;

    // --- update: one texel per particle, two attachments ---------------------------
    const material = new THREE.MeshBasicNodeMaterial();
    material.name = 'sprayUpdate';
    material.transparent = false;
    material.blending = THREE.NoBlending;
    material.depthTest = false;
    material.depthWrite = false;
    material.toneMapped = false;
    const hash = (x: F, y: F): F => fract(sin(x.mul(127.1).add(y.mul(311.7))).mul(43758.5453)) as unknown as F;
    {
      const q = uv();
      const posAge = this.posPrev.sample(q);
      const velRad = this.velPrev.sample(q);
      const alive = posAge.w.greaterThan(0.0);
      const dt = this.dt;
      // Living: gravity and quadratic drag; dies below the surface or after 2.5 s.
      const v0 = velRad.xyz;
      const radius = max(velRad.w, 0.0002);
      const speed0 = length(v0);
      const dragAcc = v0.mul(speed0).mul(float(DRAG).div(radius)).negate();
      const vel = v0.add(vec3(0.0, -GRAVITY, 0.0).add(dragAcc).mul(dt));
      const pos = posAge.xyz.add(vel.mul(dt));
      const surfUv = pos.xz.div(slabHalf.mul(2.0)).add(0.5) as unknown as V2;
      const eta = level.add(surface.sample(surfUv).r);
      const inside = max(pos.x.abs(), pos.z.abs()).lessThan(slabHalf.add(0.5));
      const aliveNext = pos.y.greaterThan(eta.sub(0.01)).and(posAge.w.lessThan(2.5)).and(inside);
      const ageNext = select(aliveNext, posAge.w.add(dt), float(0.0));

      // Dead: two candidate spots per frame; the stronger source wins. The source is
      // the impact on a boulder (foam field B) or, weaker, a bore breaking over deep
      // enough water; both are proportional to the energy flux arriving there.
      const id = q.x.mul(this.side).floor().add(q.y.mul(this.side).floor().mul(this.side));
      const r1 = hash(id, this.seed);
      const r2 = hash(id.add(17.0), this.seed.add(3.0));
      const r3 = hash(id.add(41.0), this.seed.add(7.0));
      const r4 = hash(id.add(23.0), this.seed.add(19.0));
      const r5 = hash(id.add(29.0), this.seed.add(23.0));
      const r6 = hash(id.add(53.0), this.seed.add(31.0));
      const sourceAt = (u: V2): F => {
        const f = foamField.sample(u);
        const v = simState.sample(u);
        const breaking = smoothstep(0.6, 1.0, v.a).mul(smoothstep(0.3, 1.0, length(v.gb))).mul(smoothstep(0.06, 0.15, v.r)).mul(0.4);
        const s = max(f.b, breaking);
        return (test === 1 ? v.r.greaterThan(0.05).select(float(0.3), float(0.0)) : s) as unknown as F;
      };
      const tryA = vec2(r1, r2) as unknown as V2;
      const tryB = vec2(r4, r5) as unknown as V2;
      const sourceA = sourceAt(tryA);
      const sourceB = sourceAt(tryB);
      const useB = sourceB.greaterThan(sourceA);
      const tryUv = select(useB, tryB, tryA) as unknown as V2;
      const source = select(useB, sourceB, sourceA) as unknown as F;
      const flow = simState.sample(tryUv);
      const flowSpeed = length(flow.gb);
      // Emission ∝ energy flux: the source already carries the climb speed; the
      // flow speed squared scales the chance so a fast impact throws far more.
      const spawn = source.mul(float(0.4).add(flowSpeed.mul(flowSpeed).mul(0.6))).mul(r3.add(0.5)).greaterThan(0.04);
      const tryXz = tryUv.sub(0.5).mul(2.0).mul(slabHalf);
      // Radius: skewed to small (r³ of a uniform), 0.3–4 mm.
      const radiusNew = float(0.0003).add(pow(r6, 3.0).mul(0.0037)).mul(test === 1 ? 3.0 : 1.0);
      // The jet: stagnation head u²/2g, amplified 1.5–3× for a wave front on a wall;
      // its speed is √(2 g H) = √amplification · u. The sheet leaves the wall a
      // little backward.
      // A bore of depth h meets the wall at about its own celerity √(g h) and
      // reflects; the solver's cell velocity underestimates that at the wall face.
      const bore = sqrt(float(GRAVITY).mul(max(flow.r, 0.05))).mul(1.2);
      const uImpact = max(max(flowSpeed.mul(1.5), source.mul(1.5)), bore.mul(smoothstep(0.2, 0.6, source)));
      const amplification = float(0.8).add(r3.mul(1.2));
      const jetSpeed = sqrt(amplification).mul(uImpact);
      const flowDir = flow.gb.div(max(flowSpeed, 1e-3));
      // A fan, not a column: the sheet leaves the wall over a cone of ±35° with a
      // spread of speeds, from a patch a few centimetres wide, thrown a little back.
      const r7 = hash(id.add(61.0), this.seed.add(37.0));
      const r8 = hash(id.add(67.0), this.seed.add(41.0));
      const spread = vec2(hash(id.add(5.0), this.seed.add(11.0)).sub(0.5), hash(id.add(9.0), this.seed.add(13.0)).sub(0.5)).mul(jetSpeed.mul(1.4));
      const back = flowDir.mul(jetSpeed.negate().mul(float(0.2).add(r7.mul(0.4))));
      const patch = vec2(r7.sub(0.5), r8.sub(0.5)).mul(0.08);
      // The jet leaves the face of the boulder, not its foot: the impact cell is under
      // the stone's own overhang, so the droplet starts a hand back against the flow
      // and above the surface, where the camera can see it.
      const spawnXz = tryXz.sub(flowDir.mul(0.08)).add(patch);
      const spawnPos = vec3(spawnXz.x, level.add(surface.sample(tryUv).r).add(0.05), spawnXz.y);
      const spawnVel = vec3(back.x.add(spread.x), jetSpeed.mul(float(0.5).add(r1.mul(0.7))), back.y.add(spread.y));
      const posOut = select(alive, vec4(pos, ageNext), select(spawn, vec4(spawnPos, 0.001), vec4(0.0, -10.0, 0.0, 0.0)));
      const velOut = select(alive, vec4(vel, velRad.w), select(spawn, vec4(spawnVel, radiusNew), vec4(0.0)));
      // MRT entries other than `output` are written raw (no colour chain, no clamp).
      material.mrtNode = mrt({ position: posOut, velocity: velOut });
      material.colorNode = vec4(0.0);
    }
    this.quad = new THREE.QuadMesh(material);

    // --- render: lenses stretched along their flight ---------------------------------
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
    const storedVel = this.velNode.sample(particleUv);
    // Test 2: a fixed grid of droplets 10 cm over the still-water line, no state read.
    const gridPos = vec3(particleUv.x.sub(0.5).mul(2.0).mul(slabHalf), level.add(0.1), particleUv.y.sub(0.5).mul(2.0).mul(slabHalf));
    const state = (test === 2 ? vec4(gridPos, 0.5) : stored) as unknown as V4;
    const velocity = (test === 2 ? vec4(0.0, 1.0, 0.0, 0.002) : storedVel) as unknown as V4;
    const age = state.w;
    const radius = max(velocity.w, 0.0002);
    const alive = age.greaterThan(0.0);
    const right = cameraWorldMatrix.mul(vec4(1.0, 0.0, 0.0, 0.0)).xyz as unknown as V3;
    const up = cameraWorldMatrix.mul(vec4(0.0, 1.0, 0.0, 0.0)).xyz as unknown as V3;
    // What the eye sees of a droplet is its glint and rim, about twice its radius,
    // never smaller than a few millimetres; the smallest ones hang as mist and are
    // drawn as large faint puffs instead.
    const mist = smoothstep(0.0009, 0.0004, radius);
    // In sunlight a droplet reads as its glint: a bright speck a centimetre across
    // whatever its true size; the mist plume is drawn as broad soft puffs.
    const bead = float(0.008).add(radius.mul(2.0));
    const puff = float(0.06).add(age.mul(0.08));
    const size = mix(bead, puff, mist);
    // Stretch along the velocity's screen direction (a shutter's worth of flight).
    const vView = cameraViewMatrix.mul(vec4(velocity.xyz, 0.0)).xyz;
    const vScreen = vec2(vView.x, vView.y);
    const vLen = length(vScreen);
    const axis = select(vLen.greaterThan(1e-4), vScreen.div(max(vLen, 1e-4)), vec2(1.0, 0.0)) as unknown as V2;
    const perp = vec2(axis.y.negate(), axis.x);
    // A droplet is a droplet: the motion streak is at most twice its own size. The
    // unbounded stretch drew every fast drop as a hanging icicle.
    const streak = min(vLen.mul(0.012), size.mul(2.0));
    const stretch = size.add(streak.mul(float(1.0).sub(mist)));
    const local = axis.mul(positionLocal.x.mul(stretch)).add(perp.mul(positionLocal.y.mul(size)));
    const offset = right.mul(local.x).add(up.mul(local.y)).mul(select(alive, float(1.0), float(0.0)));
    sprite.positionNode = state.xyz.add(offset);

    // A lens: the scene behind it shifted by the lens, a Fresnel rim, the sun's glint.
    const centred = uv().sub(0.5).mul(2.0);
    const rr = length(centred);
    const disc = smoothstep(1.0, 0.75, rr);
    const sphereZ = sqrt(max(float(1.0).sub(rr.mul(rr)), 0.0));
    const normalView = normalize(vec3(centred.x, centred.y, sphereZ));
    const sunView = normalize(cameraViewMatrix.mul(vec4(vec3(sunDir), 0.0)).xyz);
    const halfVec = normalize(sunView.add(vec3(0.0, 0.0, 1.0)));
    const glint = pow(clamp(dot(normalView, halfVec), 0.0, 1.0), 80.0);
    const rim = pow(float(1.0).sub(sphereZ), 3.0);
    const behind = this.screenColor.sample(screenUV.add(centred.mul(0.004)) as unknown as V2).rgb;
    const sunLit = vec3(sunColor).mul(clamp(vec3(sunDir).y, 0.0, 1.0));
    // Spray is white: a droplet scatters the sun and the sky in every direction; the
    // background shows only faintly through it, and the glint sits on top.
    const skyLit = vec3(0.9, 0.93, 0.97);
    const white = sunLit.mul(0.45).add(skyLit.mul(0.5));
    const beadColor = white.add(sunLit.mul(glint.mul(1.5))).add(behind.mul(0.15));
    const beadAlpha = disc.mul(float(0.7).add(rim.mul(0.3)));
    // The plume: aerated water, white in the sun, densest in the first half second.
    const mistColor = sunLit.mul(0.45).add(skyLit.mul(0.55));
    const mistAlpha = smoothstep(1.0, 0.0, rr).mul(0.35).mul(smoothstep(1.4, 0.3, age));
    const colorOut = mix(beadColor, mistColor, mist);
    // Fresh from the jet the sheet has not broken up yet: brighter and fuller.
    const fresh = smoothstep(0.25, 0.0, age).mul(0.5).add(1.0);
    const alphaOut = clamp(mix(beadAlpha, mistAlpha, mist).mul(fresh).mul(smoothstep(0.0, 0.03, age)), 0.0, 1.0);
    sprite.colorNode = colorOut;
    sprite.opacityNode = alphaOut;
    const sceneZ = perspectiveDepthToViewZ(this.screenDepth.sample(screenUV).x, cameraNear, cameraFar);
    sprite.fragmentNode = Fn(() => {
      // Occluded by whatever the scene drew there; dead ones draw nothing.
      Discard((test === 3 ? age.lessThan(-1.0) : positionView.z.lessThan(sceneZ.sub(0.005))).or(age.lessThan(0.0001)));
      return vec4(colorOut.mul(alphaOut), alphaOut);
    })();
    this.mesh = new THREE.InstancedMesh(geometry, sprite, side * side);
    this.mesh.name = 'spray';
    this.mesh.frustumCulled = false;
  }

  /** How many droplets are alive, and where the first few are (debugging). */
  async readStats(): Promise<{ alive: number; sample: number[][]; mean: number[]; box: number[]; yMax: number }> {
    const side = this.side;
    const raw = await this.renderer.readRenderTargetPixelsAsync(this.posRead, 0, 0, side, side, 0);
    const decode = raw instanceof Uint16Array ? (x: number) => THREE.DataUtils.fromHalfFloat(x) : (x: number) => x;
    let alive = 0;
    const sample: number[][] = [];
    const mean = [0, 0, 0];
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    let yMax = -Infinity;
    for (let i = 0; i < side * side; i++) {
      const age = decode(raw[i * 4 + 3]);
      if (age > 0) {
        alive++;
        const x = decode(raw[i * 4]), y = decode(raw[i * 4 + 1]), z = decode(raw[i * 4 + 2]);
        mean[0] += x; mean[1] += y; mean[2] += z;
        box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], z); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], z);
        yMax = Math.max(yMax, y);
        if (sample.length < 4) sample.push([x, y, z, age].map((v) => Number(v.toFixed(3))));
      }
    }
    const n = Math.max(1, alive);
    return { alive, sample, mean: mean.map((v) => Number((v / n).toFixed(2))), box: box.map((v) => Number(v.toFixed(2))), yMax: Number(yMax.toFixed(2)) };
  }

  /** The frame graph's composited colour and scene depth: refraction and occlusion. */
  bindScreen(color: THREE.Texture, depth: THREE.Texture): void {
    this.screenColor.value = color;
    this.screenDepth.value = depth;
  }

  update(dt: number): void {
    const renderer = this.renderer;
    const previous = renderer.getRenderTarget();
    if (!this.initialised) {
      // Everything starts dead: a clear to zero age.
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
    this.velNode.value = this.posRead.textures[1];
    renderer.setRenderTarget(previous);
  }
}
