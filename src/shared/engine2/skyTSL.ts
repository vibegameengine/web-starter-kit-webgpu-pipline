import * as THREE from 'three/webgpu';
import {
  Fn, Loop, If, uniform, float, vec3, int,
  dot, exp, sqrt, max, abs, acos, clamp, normalize, length, select, smoothstep,
  positionWorldDirection, positionLocal,
} from 'three/tsl';
import {
  Rg as RgJS, computePsiMS, sunTransmittanceJS, skyRadianceJS,
} from './atmosphereMath';

/**
 * SkyAtmosphere on TSL (WebGPU-first, auto-falls-back to WebGL): the same
 * Hillaire/UE model as the GLSL version — Rayleigh + Mie + ozone, isotropic
 * multiple scattering, ground bounce, transmittance-tinted sun disc.
 * The sky is pure math; no textures.
 */

// atmosphere constants (km)
const RgC = 6360.0;
const RtC = 6460.0;
const H_R = 8.0;
const H_M = 1.2;
const BETA_R = [5.802e-3, 13.558e-3, 33.1e-3] as const;
const BETA_M_S = 3.996e-3;
const BETA_M_A = 4.4e-3;
const BETA_O = [0.650e-3, 1.881e-3, 0.085e-3] as const;

export class SkyAtmosphereTSL {
  readonly uSunDir = uniform(new THREE.Vector3(0, 1, 0));
  readonly uSunIntensity = uniform(7.5);
  readonly uPsiMS = uniform(new THREE.Vector3());
  readonly uGroundAlbedo = uniform(0.3);

  /** assign to scene.backgroundNode */
  readonly backgroundNode: ReturnType<typeof Fn> extends never ? never : any;

  readonly sunDir = new THREE.Vector3(0, 1, 0);
  readonly sunColor = new THREE.Color(1, 1, 1);
  readonly zenithColor = new THREE.Color(0.2, 0.4, 0.8);
  readonly horizonColor = new THREE.Color(0.7, 0.8, 0.9);

  private envRT: THREE.RenderTarget | null = null;

  constructor() {
    // ── TSL math ─────────────────────────────────────────────────────────────
    const raySphere = Fn(([ro, rd, r]: any[]) => {
      const b = dot(ro, rd);
      const c = dot(ro, ro).sub(r.mul(r));
      const disc = b.mul(b).sub(c);
      const s = sqrt(max(disc, 0.0));
      const t0 = b.negate().sub(s);
      const t1 = b.negate().add(s);
      const t = select(t0.greaterThan(0.0), t0, t1);
      return select(disc.lessThan(0.0), float(-1.0), select(t.greaterThan(0.0), t, float(-1.0)));
    });

    const betaR = vec3(BETA_R[0], BETA_R[1], BETA_R[2]);
    const betaO = vec3(BETA_O[0], BETA_O[1], BETA_O[2]);

    const sunTransmit = Fn(([p, sun]: any[]) => {
      const tTop = raySphere(p, sun, float(RtC));
      const seg = tTop.div(12.0);
      const od = vec3(0.0).toVar();
      Loop(int(12), ({ i }: any) => {
        const sp = p.add(sun.mul(float(i).add(0.5).mul(seg)));
        const h = length(sp).sub(RgC);
        const dR = exp(h.negate().div(H_R));
        const dM = exp(h.negate().div(H_M));
        const dO = max(0.0, float(1.0).sub(abs(h.sub(25.0)).div(15.0)));
        const ext = betaR.mul(dR).add(vec3(BETA_M_S + BETA_M_A).mul(dM)).add(betaO.mul(dO));
        od.addAssign(ext.mul(seg));
      });
      const blocked = raySphere(p, sun, float(RgC)).greaterThan(0.0);
      return select(blocked, vec3(0.0), exp(od.negate()));
    });

    const skyRadiance = Fn(([rdIn]: any[]) => {
      const rd = normalize(rdIn);
      const ro = vec3(0.0, RgC + 0.002, 0.0);
      const tG = raySphere(ro, rd, float(RgC));
      const tTop = raySphere(ro, rd, float(RtC));
      const tMax = select(tG.greaterThan(0.0), tG, tTop);

      const mu = dot(rd, this.uSunDir);
      const phR = float(3.0 / (16.0 * Math.PI)).mul(mu.mul(mu).add(1.0));
      const g = 0.8;
      const dPh = float(1.0 + g * g).sub(mu.mul(2.0 * g));
      const phM = float((3.0 / (8.0 * Math.PI)) * (1.0 - g * g))
        .mul(mu.mul(mu).add(1.0))
        .div(dPh.mul(sqrt(dPh)).mul(2.0 + g * g));

      const seg = tMax.div(32.0);
      const L = vec3(0.0).toVar();
      const T = vec3(1.0).toVar();

      Loop(int(32), ({ i }: any) => {
        const p = ro.add(rd.mul(float(i).add(0.5).mul(seg)));
        const h = length(p).sub(RgC);
        const dR = exp(h.negate().div(H_R));
        const dM = exp(h.negate().div(H_M));
        const dO = max(0.0, float(1.0).sub(abs(h.sub(25.0)).div(15.0)));
        const sR = betaR.mul(dR);
        const sM = float(BETA_M_S).mul(dM);
        const ext = sR.add(vec3(BETA_M_S + BETA_M_A).mul(dM)).add(betaO.mul(dO));

        const sampleT = exp(ext.negate().mul(seg));
        const sunT = sunTransmit(p, this.uSunDir);

        const S = sR.mul(phR).add(vec3(sM.mul(phM))).mul(sunT)
          .add(sR.add(vec3(sM)).mul(this.uPsiMS));

        L.addAssign(T.mul(S.sub(S.mul(sampleT))).div(ext));
        T.mulAssign(sampleT);
      });

      // ground bounce
      If(tG.greaterThan(0.0), () => {
        const gp = ro.add(rd.mul(tG));
        const gn = normalize(gp);
        const sunT = sunTransmit(gp, this.uSunDir);
        const ndl = max(dot(gn, this.uSunDir), 0.0);
        L.addAssign(T.mul(this.uGroundAlbedo.div(Math.PI)).mul(sunT).mul(ndl));
      });

      // sun disc (0.267° angular radius, limb darkening)
      const cosSun = clamp(dot(rd, this.uSunDir), -1.0, 1.0);
      const ang = acos(cosSun);
      const SUN_R = 0.004675;
      If(ang.lessThan(SUN_R * 1.6).and(tG.lessThan(0.0)), () => {
        const Tsun = sunTransmit(ro, rd);
        const r = ang.div(SUN_R);
        const limb = sqrt(max(0.0, float(1.0).sub(r.mul(r).mul(0.9))));
        const edge = float(1.0).sub(smoothstep(0.92, 1.0, r));
        L.addAssign(Tsun.mul(120.0).mul(edge).mul(limb.mul(0.4).add(0.6)));
      });

      return L.mul(this.uSunIntensity);
    });

    this.backgroundNode = skyRadiance(positionWorldDirection);
    this.skyRadianceFn = skyRadiance;
  }

  private skyRadianceFn: any;

  /**
   * Point the sun, refresh CPU-derived colors and rebuild the sky IBL.
   * Call after renderer.init().
   */
  async setSun(
    elevationDeg: number,
    azimuthDeg: number,
    scene: THREE.Scene,
    renderer: THREE.WebGPURenderer,
  ): Promise<void> {
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
    this.uSunDir.value.copy(this.sunDir);

    const sunArr = this.sunDir.toArray();
    this.uPsiMS.value.copy(computePsiMS(sunArr));

    const t = sunTransmittanceJS([0, RgJS + 0.002, 0], sunArr);
    this.sunColor.setRGB(t[0], t[1], t[2]);

    const psi = this.uPsiMS.value;
    const intensity = this.uSunIntensity.value;
    this.zenithColor.copy(skyRadianceJS([0, 1, 0], sunArr, psi, intensity));
    const hor = new THREE.Color(0, 0, 0);
    for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      hor.add(skyRadianceJS([Math.sin(az + a) * 0.999, 0.045, Math.cos(az + a) * 0.999], sunArr, psi, intensity));
    }
    hor.multiplyScalar(0.25);
    this.horizonColor.copy(hor);

    // IBL: render the analytic sky into a PMREM (SkyLight realtime capture)
    const skyScene = new THREE.Scene();
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(50, 32, 16),
      new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide }),
    );
    (dome.material as THREE.MeshBasicNodeMaterial).colorNode = this.skyRadianceFn(normalize(positionLocal));
    skyScene.add(dome);
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT?.dispose();
    this.envRT = await pmrem.fromSceneAsync(skyScene, 0, 1, 100);
    scene.environment = this.envRT.texture;
    pmrem.dispose();
  }
}
