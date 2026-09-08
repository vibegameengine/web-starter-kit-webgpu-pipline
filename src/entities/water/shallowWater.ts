import * as THREE from 'three/webgpu';
import {
  Fn,
  abs,
  clamp,
  float,
  length,
  max,
  min,
  mix,
  select,
  sign,
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
 * Shallow-water (Saint-Venant) solver on the bathymetry — the swell entering the
 * lagoon, its shoaling, the bore it turns into, the run-up over the sand and the
 * back-wash: the *shape* of the water the surface is drawn from.
 *
 * Central-upwind finite-volume scheme of Kurganov & Petrova (2007): well-balanced
 * (a lake at rest stays at rest over any bed), positivity-preserving (depth never
 * goes negative, so a wet/dry front needs no special casing), and it captures a
 * hydraulic jump as the shock it is. State per cell is the conservative
 * (w = η − level, hu, hv); the bed enters through its values at cell corners, faces
 * are corner means and the cell bed the mean of its four faces, which is what makes
 * the balance exact. Generalized-minmod reconstruction (θ = 1.3), hydrostatic
 * correction at the faces, desingularised velocities, SSP-RK2 in time at a fixed
 * step, Manning friction applied semi-implicitly. The open sides (−x, +z) are
 * characteristic boundaries: the incoming Riemann invariant is the swell, the
 * outgoing one leaves. The other two sides are the diorama's walls.
 *
 * Consumers never read the conservative state: after each frame's sub-steps a view
 * pass writes (depth, u, v, foam source) as RGBA16F, which is what `stateNode` is.
 * See docs/water/grill-session.md Q3, Q16–Q20, Q32–Q37.
 */
export interface ShallowWaterOptions {
  renderer: THREE.WebGPURenderer;
  /** Bathymetry over the slab square: height (metres, absolute), u → +x, v → +z. */
  bathymetry: THREE.Texture;
  half: number;
  waterLevel: number;
  /** Cells across the slab. */
  size?: number;
  /** Incoming swell at the open sides (−x and +z faces): amplitude (m) and period (s). */
  swellAmplitude?: number;
  swellPeriod?: number;
  /** Direction the swell travels toward, radians in the xz plane (0 = +x, π/2 = +z). */
  swellDirection?: number;
  /** Mean still-water depth along the −x and +z faces, for the swell's velocity. */
  faceDepth?: { x: number; z: number };
}

const GRAVITY = 9.81;
/** Fixed time step (s): Courant ≤ ¼ at 3.1 cm cells for |u| ≤ 1 m/s over 1.7 m of water. */
const DT = 0.0015;
const MAX_SUBSTEPS = 12;
/** Below this the cell is dry: momentum is zeroed and nothing moves. */
const DRY = 1e-3;
/** Desingularisation ε = (1 mm)⁴: velocity in a thinner film is smoothly damped. */
const EPSILON = 1e-12;
const THETA = 1.3;

export class ShallowWater {
  readonly size: number;
  /** Metres per cell. */
  readonly cell: number;
  /** (depth, u, v, foam source) as the renderer reads it. */
  readonly stateNode: ReturnType<typeof texture>;
  readonly swellAmplitude: ReturnType<typeof uniform>;
  readonly swellPeriod: ReturnType<typeof uniform>;
  /** Unit vector the swell travels along; set through `setSwellDirection`. */
  readonly swellDir: ReturnType<typeof uniform>;
  /** Manning's n of the bed (sand ≈ 0.025). */
  readonly manning = uniform(0.025);

  private readonly renderer: THREE.WebGPURenderer;
  private readonly half: number;
  private stateA: THREE.RenderTarget;
  private stateB: THREE.RenderTarget;
  private stateC: THREE.RenderTarget;
  private readonly view: THREE.RenderTarget;
  private readonly prevNode: ReturnType<typeof texture>;
  private readonly baseNode: ReturnType<typeof texture>;
  private readonly stageMix = uniform(0);
  private readonly clock = uniform(0);
  private readonly stageQuad: THREE.QuadMesh;
  private readonly viewQuad: THREE.QuadMesh;
  private readonly initQuad: THREE.QuadMesh;
  private initialised = false;
  private _simTime = 0;
  private accumulator = 0;

  constructor(options: ShallowWaterOptions) {
    const {
      renderer, bathymetry, half, waterLevel, size = 384,
      swellAmplitude = 0.12, swellPeriod = 3.2, swellDirection = Math.atan2(-1, 1),
      faceDepth = { x: 1.2, z: 1.2 },
    } = options;
    this.renderer = renderer;
    this.half = half;
    this.size = size;
    this.cell = (2 * half) / size;
    this.swellAmplitude = uniform(swellAmplitude);
    this.swellPeriod = uniform(swellPeriod);
    this.swellDir = uniform(new THREE.Vector2(Math.cos(swellDirection), Math.sin(swellDirection)));

    const makeTarget = (filter: THREE.MagnificationTextureFilter) => {
      const target = new THREE.RenderTarget(size, size, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        depthBuffer: false,
        generateMipmaps: false,
      });
      target.texture.minFilter = filter as THREE.MinificationTextureFilter;
      target.texture.magFilter = filter;
      target.texture.wrapS = target.texture.wrapT = THREE.ClampToEdgeWrapping;
      return target;
    };
    // The conservative state is read at cell centres only — nearest, never blended.
    this.stateA = makeTarget(THREE.NearestFilter);
    this.stateB = makeTarget(THREE.NearestFilter);
    this.stateC = makeTarget(THREE.NearestFilter);
    this.view = makeTarget(THREE.LinearFilter);
    this.prevNode = texture(this.stateA.texture);
    this.baseNode = texture(this.stateA.texture);
    this.stateNode = texture(this.view.texture);

    const level = uniform(waterLevel);
    const slabHalf = uniform(half);
    const hRefX = uniform(Math.max(0.3, faceDepth.x));
    const hRefZ = uniform(Math.max(0.3, faceDepth.z));
    const n = float(size);
    const dx = float(this.cell);
    const texel = float(1 / size);
    const g = float(GRAVITY);
    const dt = float(DT);
    const bathy = texture(bathymetry);

    type V2 = ReturnType<typeof vec2>;
    type V3 = ReturnType<typeof vec3>;
    type F = ReturnType<typeof float>;
    const asV2 = (node: THREE.Node) => node as V2;
    const asV3 = (node: THREE.Node) => node as V3;
    const asF = (node: THREE.Node) => node as F;

    /** Bed relative to the still-water line, at a slab uv (bilinear in the bathymetry). */
    const bedAt = (q: V2): F => asF(bathy.sample(q).r.sub(level));

    const dataMaterial = () => {
      const material = new THREE.MeshBasicNodeMaterial();
      material.transparent = false;
      material.blending = THREE.NoBlending;
      material.depthTest = false;
      material.depthWrite = false;
      material.toneMapped = false;
      // Data, not colour: written through `fragmentNode`, past the material's output
      // chain (which clamps a signed value at zero on its way to the target).
      return material;
    };

    /** Velocity from momentum and depth, finite in a film (Kurganov–Petrova 2.21). */
    const desingularise = (hu: F, h: F): F => {
      const h4 = h.mul(h).mul(h).mul(h);
      return asF(float(Math.SQRT2).mul(h).mul(hu).div(sqrt(h4.add(max(h4, EPSILON)))));
    };
    /** Componentwise generalized minmod of three slopes. */
    const minmod3 = (a: V3, b: V3, c: V3): V3 => {
      const same = step(0.0, a.mul(b)).mul(step(0.0, a.mul(c)));
      return asV3(sign(a).mul(min(abs(a), min(abs(b), abs(c)))).mul(same));
    };

    // --- one SSP-RK2 stage ---------------------------------------------------------
    const stageMaterial = dataMaterial();
    stageMaterial.fragmentNode = Fn(() => {
      const q = uv();
      const cellIndex = q.mul(n).floor();
      const i = cellIndex.x;
      const j = cellIndex.y;

      const U = (ox: number, oz: number): V3 => asV3(this.prevNode.sample(asV2(q.add(vec2(ox, oz).mul(texel)))).xyz);
      /** Bed at a corner of the cell offset (ox, oz): corners are at ±½ texel. */
      const corner = (ox: number, oz: number): F => bedAt(asV2(q.add(vec2(ox, oz).mul(texel))));
      /** x-face bed of cell (ox, ·) on its east (+½) or west (−½) side. */
      const bedX = (ox: number, side: number): F => asF(corner(ox + side, -0.5).add(corner(ox + side, 0.5)).mul(0.5));
      const bedZ = (oz: number, side: number): F => asF(corner(-0.5, oz + side).add(corner(0.5, oz + side)).mul(0.5));

      /** Reconstructed, hydrostatically corrected west/east states of a cell along one axis. */
      const faces = (Um: V3, U0: V3, Up: V3, bW: F, bE: F) => {
        const s = minmod3(asV3(U0.sub(Um).mul(THETA)), asV3(Up.sub(Um).mul(0.5)), asV3(Up.sub(U0).mul(THETA)));
        const E = asV3(asV3(U0.add(s.mul(0.5))).toVar());
        const W = asV3(asV3(U0.sub(s.mul(0.5))).toVar());
        // Kurganov–Petrova (2.15)–(2.16): a face below the bed is lifted to it and
        // the opposite face compensates so the cell mean is kept.
        const lowE = E.x.lessThan(bE);
        W.x.assign(select(lowE, U0.x.mul(2.0).sub(bE), W.x));
        E.x.assign(select(lowE, bE, E.x));
        const lowW = W.x.lessThan(bW);
        E.x.assign(select(lowW, U0.x.mul(2.0).sub(bW), E.x));
        W.x.assign(select(lowW, bW, W.x));
        return { W, E, bE, bW, mean: U0 };
      };
      const facesX = (ox: number) => faces(U(ox - 1, 0), U(ox, 0), U(ox + 1, 0), bedX(ox, -0.5), bedX(ox, 0.5));
      const facesZ = (oz: number) => faces(U(0, oz - 1), U(0, oz), U(0, oz + 1), bedZ(oz, -0.5), bedZ(oz, 0.5));

      /**
       * Central-upwind flux through a face with bed `bf`, from the left state `L`
       * (w, hu, hv) and right state `R`. `axis` 0: x-face (normal velocity u), 1: z-face.
       */
      const flux = (L: V3, R: V3, bf: F, axis: 0 | 1): V3 => {
        const hL = max(L.x.sub(bf), 0.0);
        const hR = max(R.x.sub(bf), 0.0);
        const uL = desingularise(L.y, hL);
        const vL = desingularise(L.z, hL);
        const uR = desingularise(R.y, hR);
        const vR = desingularise(R.z, hR);
        const nL = axis === 0 ? uL : vL;
        const nR = axis === 0 ? uR : vR;
        const cL = sqrt(g.mul(hL));
        const cR = sqrt(g.mul(hR));
        const ap = max(max(nL.add(cL), nR.add(cR)), 0.0);
        const am = min(min(nL.sub(cL), nR.sub(cR)), 0.0);
        const halfG = g.mul(0.5);
        const FL = axis === 0
          ? vec3(hL.mul(uL), hL.mul(uL).mul(uL).add(halfG.mul(hL).mul(hL)), hL.mul(uL).mul(vL))
          : vec3(hL.mul(vL), hL.mul(uL).mul(vL), hL.mul(vL).mul(vL).add(halfG.mul(hL).mul(hL)));
        const FR = axis === 0
          ? vec3(hR.mul(uR), hR.mul(uR).mul(uR).add(halfG.mul(hR).mul(hR)), hR.mul(uR).mul(vR))
          : vec3(hR.mul(vR), hR.mul(uR).mul(vR), hR.mul(vR).mul(vR).add(halfG.mul(hR).mul(hR)));
        const UL = vec3(L.x, hL.mul(uL), hL.mul(vL));
        const UR = vec3(R.x, hR.mul(uR), hR.mul(vR));
        const span = ap.sub(am);
        const H = ap.mul(FL).sub(am.mul(FR)).div(span).add(ap.mul(am).div(span).mul(UR.sub(UL)));
        return asV3(select(span.greaterThan(1e-6), H, vec3(0.0)));
      };

      const cx = facesX(0);
      const xe = facesX(1);
      const xw = facesX(-1);
      const cz = facesZ(0);
      const ze = facesZ(1);
      const zw = facesZ(-1);
      const Hp = flux(cx.E, xe.W, cx.bE, 0);
      const Hm = flux(xw.E, cx.W, cx.bW, 0);
      const Gp = flux(cz.E, ze.W, cz.bE, 1);
      const Gm = flux(zw.E, cz.W, cz.bW, 1);

      const U0 = cx.mean;
      const bedCell = cx.bE.add(cx.bW).add(cz.bE).add(cz.bW).mul(0.25);
      const hCell = max(U0.x.sub(bedCell), 0.0);
      const source = vec3(0.0, g.negate().mul(hCell).mul(cx.bE.sub(cx.bW)).div(dx), g.negate().mul(hCell).mul(cz.bE.sub(cz.bW)).div(dx));
      const rate = Hp.sub(Hm).add(Gp.sub(Gm)).div(dx).negate().add(source);
      const P = asV3(U0.add(rate.mul(dt))).toVar();

      // Positivity guard, dry cells, Manning friction (semi-implicit), a speed cap.
      const hNew = max(P.x.sub(bedCell), 0.0);
      P.x.assign(bedCell.add(hNew));
      const uNew = desingularise(P.y, hNew);
      const vNew = desingularise(P.z, hNew);
      const speed = length(vec2(uNew, vNew));
      const drag = float(1.0).div(float(1.0).add(dt.mul(g).mul(this.manning).mul(this.manning).mul(speed).div(max(hNew, DRY).pow(4.0 / 3.0))));
      const capped = min(float(1.0), sqrt(g.mul(hNew)).mul(2.0).add(1.0).div(max(speed, 1e-6)));
      const wet = step(DRY, hNew);
      P.y.assign(hNew.mul(uNew).mul(drag).mul(capped).mul(wet));
      P.z.assign(hNew.mul(vNew).mul(drag).mul(capped).mul(wet));

      // SSP-RK2: stage 1 is the Euler step; stage 2 averages it with the base state.
      const base = asV3(this.baseNode.sample(q).xyz);
      const advanced = mix(P, base.add(P).mul(0.5), this.stageMix);

      // --- boundaries: two rings of cells set, not evolved ------------------------
      const openX = i.lessThan(2.0);
      const openZ = j.greaterThan(n.sub(2.5));
      const wallX = i.greaterThan(n.sub(2.5));
      const wallZ = j.lessThan(2.0);

      const omega = float(2 * Math.PI).div(this.swellPeriod);
      const dir = asV2(this.swellDir);
      const xz = q.sub(0.5).mul(2.0).mul(slabHalf);
      /** Characteristic ghost state for an open face with inward normal `normal` and reference depth hRef. */
      const ghost = (interiorUv: V2, normal: V2, hRef: F, entering: F): V3 => {
        const kFace = omega.div(sqrt(g.mul(hRef)));
        const etaExt = this.swellAmplitude.mul(sin(this.clock.mul(omega).sub(kFace.mul(xz.x.mul(dir.x).add(xz.y.mul(dir.y)))))).mul(entering);
        const velExt = dir.mul(etaExt.mul(sqrt(g.div(hRef))));
        const hExt = max(etaExt.sub(bedCell), 0.0);
        const unExt = velExt.x.mul(normal.x).add(velExt.y.mul(normal.y));
        const Ui = asV3(this.prevNode.sample(interiorUv).xyz);
        const bedInt = bedAt(interiorUv);
        const hInt = max(Ui.x.sub(bedInt), 0.0);
        const uInt = desingularise(Ui.y, hInt);
        const vInt = desingularise(Ui.z, hInt);
        const unInt = uInt.mul(normal.x).add(vInt.mul(normal.y));
        const rPlus = unExt.add(sqrt(g.mul(hExt)).mul(2.0));
        const rMinus = unInt.sub(sqrt(g.mul(hInt)).mul(2.0));
        const unG = rPlus.add(rMinus).mul(0.5);
        const cG = max(rPlus.sub(rMinus).mul(0.25), 0.0);
        const hG = cG.mul(cG).div(g);
        // Tangential component: from outside while inflow, from inside while outflow.
        const tangent = vec2(normal.y.negate(), normal.x);
        const utExt = velExt.x.mul(tangent.x).add(velExt.y.mul(tangent.y));
        const utInt = uInt.mul(tangent.x).add(vInt.mul(tangent.y));
        const utG = select(unG.greaterThan(0.0), utExt, utInt);
        const velG = normal.mul(unG).add(tangent.mul(utG));
        return asV3(vec3(bedCell.add(hG), hG.mul(velG.x), hG.mul(velG.y)));
      };
      const ghostX = ghost(asV2(vec2(float(2.5).mul(texel), q.y)), asV2(vec2(1.0, 0.0)), asF(hRefX), asF(max(sign(dir.x), 0.0)));
      const ghostZ = ghost(asV2(vec2(q.x, n.sub(2.5).mul(texel))), asV2(vec2(0.0, -1.0)), asF(hRefZ), asF(max(sign(dir.y.negate()), 0.0)));
      // Walls mirror the interior: the cell across the face, normal momentum reversed.
      const mirrorX = asV3(this.prevNode.sample(asV2(vec2(n.mul(2.0).sub(5.0).sub(i).add(0.5).mul(texel), q.y))).xyz);
      const mirrorZ = asV3(this.prevNode.sample(asV2(vec2(q.x, float(3.0).sub(j).add(0.5).mul(texel)))).xyz);
      const wallXState = vec3(mirrorX.x, mirrorX.y.negate(), mirrorX.z);
      const wallZState = vec3(mirrorZ.x, mirrorZ.y, mirrorZ.z.negate());

      const result = select(openX, ghostX, select(wallX, wallXState, select(openZ, ghostZ, select(wallZ, wallZState, advanced))));
      return vec4(result, 0.0);
    })();
    this.stageQuad = new THREE.QuadMesh(stageMaterial);

    // --- initial state: a lake at rest --------------------------------------------
    const initMaterial = dataMaterial();
    initMaterial.fragmentNode = Fn(() => {
      const q = uv();
      const corner = (ox: number, oz: number): F => bedAt(asV2(q.add(vec2(ox, oz).mul(texel))));
      const bedCell = corner(-0.5, -0.5).add(corner(0.5, -0.5)).add(corner(-0.5, 0.5)).add(corner(0.5, 0.5)).mul(0.25);
      return vec4(max(bedCell, 0.0), 0.0, 0.0, 0.0);
    })();
    this.initQuad = new THREE.QuadMesh(initMaterial);

    // --- view: (depth, u, v, foam source) for everything that draws the water ------
    const viewMaterial = dataMaterial();
    viewMaterial.fragmentNode = Fn(() => {
      const q = uv();
      const U = (ox: number, oz: number): V3 => asV3(this.prevNode.sample(asV2(q.add(vec2(ox, oz).mul(texel)))).xyz);
      const corner = (ox: number, oz: number): F => bedAt(asV2(q.add(vec2(ox, oz).mul(texel))));
      const bedOf = (ox: number, oz: number): F =>
        asF(corner(ox - 0.5, oz - 0.5).add(corner(ox + 0.5, oz - 0.5)).add(corner(ox - 0.5, oz + 0.5)).add(corner(ox + 0.5, oz + 0.5)).mul(0.25));
      const U0 = U(0, 0);
      const bedCell = bedOf(0, 0);
      const h = max(U0.x.sub(bedCell), 0.0);
      const u = desingularise(U0.y, h);
      const v = desingularise(U0.z, h);
      const wet = step(DRY, h);
      // Depth as the sheet needs it: over the bathymetry texel, so η = b + d there.
      const bedTexel = bedAt(asV2(q));
      const depth = max(U0.x.sub(bedTexel), 0.0).mul(wet);

      // Foam source. A hydraulic jump between two cells dissipates
      // D = g·√(g·h̄)·Δh³/(4·h₁·h₂) per unit width (the classic bore loss); it fires
      // only where the characteristics converge. Scaled by the dissipation that
      // fills coverage in 0.3 s. Plus the run-up front: a thin tongue in motion.
      const jump = (Ua: V3, ba: F, Ub: V3, bb: F, axis: 0 | 1): F => {
        const ha = max(Ua.x.sub(ba), DRY);
        const hb = max(Ub.x.sub(bb), DRY);
        const na = axis === 0 ? desingularise(Ua.y, ha) : desingularise(Ua.z, ha);
        const nb = axis === 0 ? desingularise(Ub.y, hb) : desingularise(Ub.z, hb);
        // Either family of characteristics converging is a shock: u+c for a jump
        // running toward +axis, u−c for one running toward −axis (the swell comes in
        // along −z, so the second family is the one the beach sees).
        const ca = sqrt(g.mul(ha));
        const cb = sqrt(g.mul(hb));
        const converge = step(0.1, max(na.add(ca).sub(nb.add(cb)), na.sub(ca).sub(nb.sub(cb))));
        // A jump is a step in the *surface* between two wet cells; a step in the bed
        // (a boulder's face) with still water on both sides is not one.
        const bothWet = step(DRY * 2.0, ha).mul(step(DRY * 2.0, hb));
        const bedStep = smoothstep(0.12, 0.04, abs(ba.sub(bb)));
        const dh = abs(hb.add(bb).sub(ha.add(ba)));
        const hMean = ha.add(hb).mul(0.5);
        const D = g.mul(sqrt(g.mul(hMean))).mul(dh).mul(dh).mul(dh).div(ha.mul(hb).mul(4.0));
        return asF(D.mul(converge).mul(bothWet).mul(bedStep).div(0.045));
      };
      const jx = max(jump(U(-1, 0), bedOf(-1, 0), U0, bedCell, 0), jump(U0, bedCell, U(1, 0), bedOf(1, 0), 0));
      const jz = max(jump(U(0, -1), bedOf(0, -1), U0, bedCell, 1), jump(U0, bedCell, U(0, 1), bedOf(0, 1), 1));
      const bore = max(jx, jz).mul(smoothstep(0.6, 0.02, h));
      // The run-up front: the tongue's leading edge, thin and moving. Judged over the
      // depths the sheet is drawn at (4 mm .. 8 cm), not only the invisible film.
      const speedHere = length(vec2(u, v));
      // ...and only over a gentle bed: the film sloshing at the foot of a boulder is
      // not a run-up front, and it painted a jagged collar around every rock.
      const bedSlope = length(vec2(bedOf(1, 0).sub(bedOf(-1, 0)), bedOf(0, 1).sub(bedOf(0, -1)))).div(dx.mul(2.0));
      const gentleBed = smoothstep(0.6, 0.25, bedSlope);
      const front = smoothstep(0.25, 0.7, speedHere).mul(smoothstep(0.004, 0.012, h)).mul(smoothstep(0.08, 0.03, h)).mul(wet).mul(gentleBed);
      const foam = clamp(max(bore, front), 0.0, 1.0);
      return vec4(depth, clamp(u, -6.0, 6.0).mul(wet), clamp(v, -6.0, 6.0).mul(wet), foam);
    })();
    this.viewQuad = new THREE.QuadMesh(viewMaterial);
  }

  /** Points the incoming swell: radians in the xz plane, 0 = toward +x, π/2 = toward +z. */
  setSwellDirection(radians: number): void {
    (this.swellDir.value as THREE.Vector2).set(Math.cos(radians), Math.sin(radians));
  }

  /** The fixed sub-step, seconds. */
  get timeStep(): number {
    return DT;
  }

  private substep(): void {
    const renderer = this.renderer;
    this._simTime += DT;
    this.clock.value = this._simTime;
    // Stage 1: A → B (Euler).
    this.stageMix.value = 0;
    this.prevNode.value = this.stateA.texture;
    this.baseNode.value = this.stateA.texture;
    renderer.setRenderTarget(this.stateB);
    this.stageQuad.render(renderer);
    // Stage 2: from B, averaged with A → C.
    this.stageMix.value = 1;
    this.prevNode.value = this.stateB.texture;
    renderer.setRenderTarget(this.stateC);
    this.stageQuad.render(renderer);
    const a = this.stateA;
    this.stateA = this.stateC;
    this.stateC = a;
  }

  private ensureInitialised(): void {
    if (this.initialised) return;
    this.renderer.setRenderTarget(this.stateA);
    this.initQuad.render(this.renderer);
    this.initialised = true;
  }

  private writeView(): void {
    this.prevNode.value = this.stateA.texture;
    this.renderer.setRenderTarget(this.view);
    this.viewQuad.render(this.renderer);
    this.stateNode.value = this.view.texture;
  }

  /**
   * Advances the water by `dt` seconds of wall time at the fixed step; at most
   * MAX_SUBSTEPS per call, the remainder dropped (the water never runs slow).
   */
  step(dt: number): void {
    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    this.ensureInitialised();
    this.accumulator += dt;
    let steps = Math.floor(this.accumulator / DT);
    if (steps > MAX_SUBSTEPS) {
      steps = MAX_SUBSTEPS;
      this.accumulator = 0;
    } else {
      this.accumulator -= steps * DT;
    }
    for (let k = 0; k < steps; k++) this.substep();
    this.writeView();
    renderer.setRenderTarget(previousTarget);
  }

  get simTime(): number {
    return this._simTime;
  }

  /** The view read back from the GPU as floats (the target is half-float; decode it). */
  async readState(): Promise<{ size: number; depth: Float32Array; u: Float32Array; v: Float32Array; foam: Float32Array }> {
    const size = this.size;
    const raw = await this.renderer.readRenderTargetPixelsAsync(this.view, 0, 0, size, size);
    const n = size * size;
    const depth = new Float32Array(n);
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const foam = new Float32Array(n);
    const decode = raw instanceof Uint16Array ? (x: number) => THREE.DataUtils.fromHalfFloat(x) : (x: number) => x;
    for (let i = 0; i < n; i++) {
      depth[i] = decode(raw[i * 4]);
      u[i] = decode(raw[i * 4 + 1]);
      v[i] = decode(raw[i * 4 + 2]);
      foam[i] = decode(raw[i * 4 + 3]);
    }
    return { size, depth, u, v, foam };
  }

  /** The conservative state itself (w = η − level, hu, hv) at a few probe cells, for debugging the solver. */
  async readProbe(): Promise<{ wMin: number; wMax: number; huMax: number; huMin: number; faceW: number[]; rowW: number[] }> {
    const size = this.size;
    const raw = await this.renderer.readRenderTargetPixelsAsync(this.stateA, 0, 0, size, size);
    const decode = raw instanceof Uint16Array ? (x: number) => THREE.DataUtils.fromHalfFloat(x) : (x: number) => x;
    let wMin = Infinity, wMax = -Infinity, huMax = 0, huMin = 0;
    const j = Math.floor(size * 0.35);
    const faceW: number[] = [];
    const rowW: number[] = [];
    for (let i = 0; i < size; i++) {
      const k = (j * size + i) * 4;
      const w = decode(raw[k]);
      if (i < 8) faceW.push(Number(w.toFixed(4)));
      if (i % 24 === 0) rowW.push(Number(w.toFixed(4)));
    }
    for (let k = 0; k < size * size; k++) {
      const w = decode(raw[k * 4]);
      const huSigned = decode(raw[k * 4 + 1]);
      huMin = Math.min(huMin, huSigned);
      const hu = Math.abs(huSigned);
      // Only cells that can hold water: w below +0.5 m (land above that is just its own bed).
      if (w < 0.5) { wMin = Math.min(wMin, w); wMax = Math.max(wMax, w); }
      huMax = Math.max(huMax, hu);
    }
    return { wMin, wMax, huMax, huMin, faceW, rowW };
  }

  /** Min / max / mean of depth, |velocity| and foam over the grid. */
  async readStats(): Promise<Record<string, number>> {
    const { size, depth, u, v, foam } = await this.readState();
    let dMin = Infinity, dMax = -Infinity, dSum = 0, speedMax = 0, speedSum = 0, foamSum = 0, wet = 0;
    for (let i = 0; i < size * size; i++) {
      const speed = Math.hypot(u[i], v[i]);
      dMin = Math.min(dMin, depth[i]); dMax = Math.max(dMax, depth[i]); dSum += depth[i];
      speedMax = Math.max(speedMax, speed); speedSum += speed; foamSum += foam[i];
      if (depth[i] > 0.003) wet++;
    }
    const n = size * size;
    return { dMin, dMax, dMean: dSum / n, speedMax, speedMean: speedSum / n, foamMean: foamSum / n, wetFraction: wet / n, simTime: this._simTime };
  }

  /** Texture uv of a world (x, z) on the slab. */
  uvOf(xz: THREE.Node) {
    return (xz as ReturnType<typeof vec2>).div(this.half * 2).add(0.5);
  }

  /**
   * Runs the water forward before the first frame so a capture does not show a pond
   * that has not yet heard about the swell. Sub-steps only; no frame is drawn.
   */
  preroll(seconds: number): void {
    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    this.ensureInitialised();
    const steps = Math.min(4000, Math.ceil(seconds / DT));
    for (let k = 0; k < steps; k++) this.substep();
    this.writeView();
    renderer.setRenderTarget(previousTarget);
  }
}
