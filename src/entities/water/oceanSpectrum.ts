import * as THREE from 'three/webgpu';
import { Fn, Loop, cos, dot, float, fwidth, max, sin, uniform, uniformArray, vec2, vec3, vec4 } from 'three/tsl';
import { eckvSpectrum } from './physicsReference.ts';
import { seededRandom } from '../../shared/lib/noise.ts';

export interface OceanSpectrumOptions {
  windSpeed: number;
  windDirection?: number;
  inverseWaveAge?: number;
  longestWave: number;
  geometryWavelength: number;
  depth: number;
}

export class OceanSpectrum {
  readonly clock = uniform(0);
  readonly longCount = 96;
  readonly shortCount = 48;
  readonly unresolvedVariance = uniform(0);
  readonly moments = { elevation: 0, slope: 0, geometrySlope: 0, shortSlope: 0 };
  private readonly coefficients: THREE.Vector4[] = [];
  private readonly phases: number[] = [];
  private readonly coefficientNodes: ReturnType<typeof uniformArray>;
  private readonly phaseNodes: ReturnType<typeof uniformArray>;
  private readonly options: Required<OceanSpectrumOptions>;

  constructor(options: OceanSpectrumOptions) {
    this.options = { windDirection: Math.atan2(-0.4, 0.9), inverseWaveAge: 1, ...options };
    for (let i = 0; i < this.longCount + this.shortCount; i++) {
      this.coefficients.push(new THREE.Vector4());
      this.phases.push(0);
    }
    this.rebuild();
    this.coefficientNodes = uniformArray(this.coefficients, 'vec4');
    this.phaseNodes = uniformArray(this.phases, 'float');
  }

  get windSpeed() { return this.options.windSpeed; }
  get windDirection() { return this.options.windDirection; }

  setWind(speed: number, direction: number) {
    this.options.windSpeed = speed;
    this.options.windDirection = direction;
    this.rebuild();
  }

  private rebuild() {
    const { windSpeed, windDirection, inverseWaveAge, longestWave, geometryWavelength, depth } = this.options;
    const random = seededRandom(9183);
    Object.assign(this.moments, { elevation: 0, slope: 0, geometrySlope: 0, shortSlope: 0 });
    if (windSpeed === 0) {
      for (const coefficient of this.coefficients) coefficient.set(0, 0, 0, 0);
      return;
    }
    const ranges = [[2 * Math.PI / longestWave, 2 * Math.PI / geometryWavelength, this.longCount, 0], [2 * Math.PI / geometryWavelength, 5000, this.shortCount, this.longCount]];
    for (const [start, end, count, offset] of ranges) {
      const logStep = Math.log(end / start) / count;
      for (let i = 0; i < count; i++) {
        let variance = 0;
        let slopeVariance = 0;
        const logStart = Math.log(start) + i * logStep;
        for (let tap = 0; tap < 16; tap++) {
          const k = Math.exp(logStart + (tap + 0.5) * logStep / 16);
          const sample = eckvSpectrum(k, windSpeed, inverseWaveAge);
          variance += sample.elevation * k * logStep / 16;
          slopeVariance += sample.slope * k * logStep / 16;
        }
        const k = variance > 1e-30 ? Math.sqrt(slopeVariance / variance) : Math.exp(logStart + logStep / 2);
        const sample = eckvSpectrum(k, windSpeed, inverseWaveAge);
        const quantile = random();
        let lo = -Math.PI;
        let hi = Math.PI;
        for (let step = 0; step < 30; step++) {
          const angle = (lo + hi) / 2;
          const cdf = (angle + Math.PI + sample.spreadingDelta * Math.sin(2 * angle) / 2) / (2 * Math.PI);
          if (cdf < quantile) lo = angle; else hi = angle;
        }
        const direction = (lo + hi) / 2 + windDirection;
        const index = offset + i;
        this.coefficients[index].set(Math.cos(direction) * k, Math.sin(direction) * k, sample.omega * Math.sqrt(Math.tanh(k * depth)), Math.sqrt(2 * variance));
        this.phases[index] = random() * 2 * Math.PI;
        this.moments.elevation += variance;
        this.moments.slope += slopeVariance;
        if (offset === 0) this.moments.geometrySlope += slopeVariance;
        else this.moments.shortSlope += slopeVariance;
      }
    }
  }

  evaluate = Fn(([xz]: [ReturnType<typeof vec2>]) => {
    const sum = vec3(0).toVar();
    Loop(this.longCount, ({ i }) => {
      const coefficient = this.coefficientNodes.element(i) as unknown as ReturnType<typeof vec4>;
      const phase = dot(xz, coefficient.xy).sub(coefficient.z.mul(this.clock)).add(this.phaseNodes.element(i));
      sum.x.addAssign(sin(phase).mul(coefficient.w));
      sum.yz.addAssign(coefficient.xy.mul(cos(phase)).mul(coefficient.w));
    });
    return sum;
  });

  detail = Fn(([xz]: [ReturnType<typeof vec2>]) => {
    const slope = vec2(0).toVar();
    const variance = float(this.unresolvedVariance).toVar();
    Loop({ start: this.longCount, end: this.longCount + this.shortCount }, ({ i }) => {
      const c = this.coefficientNodes.element(i) as unknown as ReturnType<typeof vec4>;
      const phase = dot(xz, c.xy).sub(c.z.mul(this.clock)).add(this.phaseNodes.element(i));
      const pixelPhase = dot(fwidth(xz), c.xy.abs());
      const weight = float(1).sub(pixelPhase.smoothstep(Math.PI * 0.5, Math.PI));
      slope.addAssign(c.xy.mul(cos(phase)).mul(c.w).mul(weight));
      variance.addAssign(c.xy.dot(c.xy).mul(c.w.pow(2)).mul(0.5).mul(float(1).sub(weight.pow(2))));
    });
    return vec3(slope, max(variance, 0));
  });
}
