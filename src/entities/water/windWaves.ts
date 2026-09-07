import * as THREE from 'three/webgpu';
import {
  Fn,
  cos,
  float,
  sin,
  exp,
  sqrt,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { seededRandom } from '../../shared/lib/noise.ts';

/**
 * Wind waves from an oceanographic spectrum, evaluated as a sum of spectral
 * components (linear Airy theory).
 *
 * The shallow-water solver carries the swell and the run-up; it is non-dispersive
 * and cannot hold the 5–50 cm wind waves that give a lagoon its texture. Those obey
 * the finite-depth dispersion relation ω² = g·k·tanh(k·h): frequency is conserved as
 * a wave travels into shallower water while its wavenumber grows (shoaling) — so k is
 * re-solved per point from the local depth. Amplitudes come from a JONSWAP spectrum
 * with the TMA finite-depth correction and a cos² directional spread about the wind.
 *
 * `N` components sampled from the spectrum stand in for an FFT: exact for these
 * statistics at the price of O(N) per vertex/pixel, which at N=48 is cheap here.
 */
export interface WindWaveOptions {
  /** Wind speed at 10 m, m/s (fetch-limited JONSWAP). */
  windSpeed?: number;
  /** Direction the wind blows toward, radians in the xz plane (0 = +x). */
  windDirection?: number;
  /** Fetch, metres; sets the spectral peak. */
  fetch?: number;
  components?: number;
  seed?: number;
  /** Global amplitude multiplier for art direction after the physics. */
  gain?: number;
}

const GRAVITY = 9.81;

/** JONSWAP energy spectrum S(ω) (Hasselmann et al. 1973). */
function jonswap(omega: number, omegaPeak: number, alpha: number, gamma = 3.3): number {
  const sigma = omega <= omegaPeak ? 0.07 : 0.09;
  const r = Math.exp(-((omega - omegaPeak) ** 2) / (2 * sigma * sigma * omegaPeak * omegaPeak));
  return ((alpha * GRAVITY * GRAVITY) / omega ** 5) * Math.exp(-1.25 * (omegaPeak / omega) ** 4) * gamma ** r;
}

/** TMA finite-depth factor φ(ω, h) (Bouws et al. 1985), depth h in metres. */
function tmaFactor(omega: number, h: number): number {
  const wh = omega * Math.sqrt(h / GRAVITY);
  if (wh <= 1) return 0.5 * wh * wh;
  if (wh < 2) return 1 - 0.5 * (2 - wh) ** 2;
  return 1;
}

export class WindWaves {
  readonly count: number;
  /** Seconds on the water's own clock (the solver's), not the renderer's. */
  readonly clock = uniform(0);
  /** (kx, kz, omega, amplitude) per component. */
  private readonly params: THREE.Vector4[] = [];
  private readonly phases: number[] = [];
  private readonly paramsNode: ReturnType<typeof uniformArray>;
  private readonly phasesNode: ReturnType<typeof uniformArray>;

  private readonly options: Required<WindWaveOptions>;

  constructor(options: WindWaveOptions = {}) {
    this.options = {
      windSpeed: 4.5,
      windDirection: Math.atan2(-0.4, 0.9),
      fetch: 800,
      components: 48,
      seed: 11,
      gain: 1,
      ...options,
    };
    this.count = this.options.components;
    for (let i = 0; i < this.count; i++) {
      this.params.push(new THREE.Vector4());
      this.phases.push(0);
    }
    this.sample();
    this.paramsNode = uniformArray(this.params, 'vec4');
    this.phasesNode = uniformArray(this.phases, 'float');
  }

  /** Re-samples the spectrum for a new wind; the uniform arrays are updated in place. */
  setWind(windSpeed: number, windDirection: number, gain = this.options.gain): void {
    this.options.windSpeed = windSpeed;
    this.options.windDirection = windDirection;
    this.options.gain = gain;
    this.sample();
  }

  get windSpeed(): number { return this.options.windSpeed; }
  get windDirection(): number { return this.options.windDirection; }

  private sample(): void {
    const { windSpeed, windDirection, fetch, components, seed, gain } = this.options;
    const random = seededRandom(seed);

    // Fetch-limited JONSWAP peak and alpha (Hasselmann): dimensionless fetch.
    const xTilde = (GRAVITY * fetch) / (windSpeed * windSpeed);
    const omegaPeak = 22 * (GRAVITY / windSpeed) * xTilde ** -0.33;
    const alpha = 0.076 * xTilde ** -0.22;
    // Reference depth for the TMA correction: a lagoon, not the open sea.
    const hRef = 1.2;

    // Sample ω log-uniformly between 0.6 ωp and 6 ωp (5 cm .. metres), θ from cos².
    const omegaMin = omegaPeak * 0.6;
    const omegaMax = omegaPeak * 6.0;
    const dLogOmega = Math.log(omegaMax / omegaMin) / components;
    for (let i = 0; i < components; i++) {
      const omega = omegaMin * Math.exp((i + random()) * dLogOmega);
      const dOmega = omega * dLogOmega;
      // cos² spreading: sample θ by inverse-transform of the cos² CDF.
      const u = random() * 2 - 1;
      const theta = windDirection + Math.asin(u) * 0.9;
      const spread = (2 / Math.PI) * Math.cos(theta - windDirection) ** 2;
      const energy = jonswap(omega, omegaPeak, alpha) * tmaFactor(omega, hRef) * dOmega * spread * Math.PI;
      const amplitude = Math.sqrt(2 * Math.max(energy, 0)) * gain;
      // Deep-water k for the seed; the shader re-solves k(h) per point.
      const k = (omega * omega) / GRAVITY;
      this.params[i].set(Math.cos(theta) * k, Math.sin(theta) * k, omega, amplitude);
      this.phases[i] = random() * Math.PI * 2;
    }
  }

  /** Total significant amplitude (for capping the surface). */
  get amplitudeSum(): number {
    return this.params.reduce((sum, p) => sum + p.w, 0);
  }

  /**
   * Height (x), and the surface slope (y = ∂η/∂x, z = ∂η/∂z) at world xz for local
   * depth `depth`. Frequency conserved; k(h) from one Newton step on the dispersion
   * relation, amplitude by Green's law (h^-1/4) relative to the reference depth.
   */
  evaluate = Fn(([xz, depth]: [ReturnType<typeof vec2>, ReturnType<typeof float>]) => {
    const h = depth.max(float(0.05));
    // tanh via exp: TSL has none.
    const tanhOf = (x: ReturnType<typeof float>) => {
      const e = exp(x.min(float(10.0)).mul(2.0));
      return e.sub(1.0).div(e.add(1.0));
    };
    const height = float(0.0).toVar();
    const slopeX = float(0.0).toVar();
    const slopeZ = float(0.0).toVar();
    const shoal = float(1.2).div(h).pow(0.25).min(float(2.2));
    for (let i = 0; i < this.count; i++) {
      const c = this.paramsNode.element(float(i)) as unknown as ReturnType<typeof vec4>;
      const phase0 = this.phasesNode.element(float(i)) as unknown as ReturnType<typeof float>;
      const kDeep = sqrt(c.x.mul(c.x).add(c.y.mul(c.y)));
      // ω² = g k tanh(k h): k = k_deep / tanh(k h), one fixed-point step from k_deep.
      const k = kDeep.div(tanhOf(kDeep.mul(h)).max(float(0.05)));
      const dir = vec2(c.x, c.y).div(kDeep.max(float(1e-4)));
      const theta = dir.x.mul(xz.x).add(dir.y.mul(xz.y)).mul(k).sub(c.z.mul(this.clock)).add(phase0);
      const a = c.w.mul(shoal);
      height.addAssign(sin(theta).mul(a));
      const d = cos(theta).mul(a).mul(k);
      slopeX.addAssign(d.mul(dir.x));
      slopeZ.addAssign(d.mul(dir.y));
    }
    return vec3(height, slopeX, slopeZ);
  });
}

