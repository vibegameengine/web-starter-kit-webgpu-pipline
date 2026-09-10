import * as THREE from 'three/webgpu';
import { Fn, Loop, float, max, texture, uniform, uint, uv, vec2, vec3, vec4, wgslFn } from 'three/tsl';
import { eckvSpectrum } from './physicsReference.ts';
import { seededRandom } from '../../shared/lib/noise.ts';

const evolve = wgslFn(`
  fn oceanEvolve(initial: texture_2d<f32>, pixel: vec2f, size: u32, period: f32, depth: f32, clock: f32, transport: u32) -> vec4f {
    let index = vec2i(pixel);
    let signedIndex = vec2i(select(index.x, index.x - i32(size), index.x >= i32(size / 2u)),
      select(index.y, index.y - i32(size), index.y >= i32(size / 2u)));
    let k = vec2f(signedIndex) * (6.28318530718 / period);
    let magnitude = length(k);
    if (magnitude < 1e-6) { return vec4f(0.0); }
    let omega = sqrt(9.82 * magnitude * (1.0 + pow(magnitude / 370.0, 2.0)) * tanh(magnitude * depth));
    let phase = omega * clock;
    let h0 = textureLoad(initial, index, 0);
    let real = ((h0.x + h0.z) * cos(phase) + (h0.y + h0.w) * sin(phase)) * 0.70710678118;
    let imaginary = ((h0.y - h0.w) * cos(phase) + (h0.z - h0.x) * sin(phase)) * 0.70710678118;
    if (transport == 2u) {
      let displacement = k / magnitude;
      return vec4f(-displacement.x * imaginary - displacement.y * real,
        displacement.x * real - displacement.y * imaginary, -magnitude * real, -magnitude * imaginary);
    }
    if (transport == 1u) {
      let rateReal = omega * (-(h0.x + h0.z) * sin(phase) + (h0.y + h0.w) * cos(phase)) * 0.70710678118;
      let rateImaginary = omega * (-(h0.y - h0.w) * sin(phase) + (h0.z - h0.x) * cos(phase)) * 0.70710678118;
      let velocity = k / (magnitude * tanh(magnitude * depth));
      return vec4f(-velocity.x * rateImaginary - velocity.y * rateReal,
        velocity.x * rateReal - velocity.y * rateImaginary, -omega * omega * real, -omega * omega * imaginary);
    }
    return vec4f(-k.x * imaginary - k.y * real, k.x * real - k.y * imaginary, real, imaginary);
  }
`);

const inverseStage = wgslFn(`
  fn oceanInverseStage(source: texture_2d<f32>, pixel: vec2f, axis: u32, stage: u32, bits: u32) -> vec4f {
    let outputIndex = vec2u(pixel);
    let halfBlock = 1u << stage;
    let blockSize = halfBlock * 2u;
    let lane = outputIndex[axis] % blockSize;
    let offset = lane % halfBlock;
    var a = outputIndex;
    var b = outputIndex;
    a[axis] = outputIndex[axis] / blockSize * blockSize + offset;
    b[axis] = a[axis] + halfBlock;
    if (stage == 0u) {
      a[axis] = reverseBits(a[axis]) >> (32u - bits);
      b[axis] = reverseBits(b[axis]) >> (32u - bits);
    }
    let first = textureLoad(source, vec2i(a), 0);
    let second = textureLoad(source, vec2i(b), 0);
    let angle = 6.28318530718 * f32(offset) / f32(blockSize);
    let product = vec4f(second.x * cos(angle) - second.y * sin(angle), second.x * sin(angle) + second.y * cos(angle),
      second.z * cos(angle) - second.w * sin(angle), second.z * sin(angle) + second.w * cos(angle));
    return first + select(product, -product, lane >= halfBlock);
  }
`);

interface DetailOptions {
  renderer: THREE.WebGPURenderer;
  clock: ReturnType<typeof uniform>;
  windSpeed: number;
  windDirection: number;
  inverseWaveAge: number;
  depth: number;
  longestWavelength: number;
  domainLength?: number;
}

class SpectralBand {
  readonly output: THREE.RenderTarget;
  readonly initial: THREE.DataTexture;
  expectedSlopeVariance: number;
  accelerationVariance = 0;
  accelerationRateVariance = 0;
  readonly transport: THREE.RenderTarget | null;
  private readonly transportEvolve: THREE.QuadMesh | null;
  private readonly transportResolve: THREE.QuadMesh | null;
  readonly displacement: THREE.RenderTarget | null;
  private readonly displacementEvolve: THREE.QuadMesh | null;
  private readonly targets: THREE.RenderTarget[];
  private readonly evolveQuad: THREE.QuadMesh;
  private readonly stages: THREE.QuadMesh[] = [];
  private readonly resolveQuad: THREE.QuadMesh;

  constructor(readonly length: number, private readonly minK: number, private readonly maxK: number, private readonly options: DetailOptions, private readonly seed: number, readonly size = 256, withTransport = false) {
    const random = seededRandom(seed);
    const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());
    const initial = new Float32Array(size * size * 4);
    const amplitudes = new Float32Array(size * size * 2);
    const dk = 2 * Math.PI / length;
    let expectedSlopeVariance = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const kx = (x < size / 2 ? x : x - size) * dk;
      const kz = (y < size / 2 ? y : y - size) * dk;
      const k = Math.hypot(kx, kz);
      if (k < minK || k >= maxK || options.windSpeed === 0) continue;
      const density = eckvSpectrum(k, options.windSpeed, options.inverseWaveAge);
      const angle = Math.atan2(kz, kx) - options.windDirection;
      if (Math.cos(angle) < 0) continue;
      const spreading = (1 + density.spreadingDelta * Math.cos(2 * angle)) / Math.PI;
      const variance = density.elevation * spreading / k * dk * dk;
      const amplitude = Math.sqrt(variance / 2);
      const at = (y * size + x) * 2;
      amplitudes[at] = gaussian() * amplitude;
      amplitudes[at + 1] = gaussian() * amplitude;
      expectedSlopeVariance += variance * k * k;
      const omega2 = 9.82 * k * (1 + (k / 370) ** 2) * Math.tanh(k * options.depth);
      this.accelerationVariance += variance * omega2 ** 2;
      this.accelerationRateVariance += variance * omega2 ** 3;
    }
    this.expectedSlopeVariance = expectedSlopeVariance;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const at = y * size + x;
      const mirror = ((size - y) % size) * size + (size - x) % size;
      initial.set([amplitudes[at * 2], amplitudes[at * 2 + 1], amplitudes[mirror * 2], amplitudes[mirror * 2 + 1]], at * 4);
    }
    this.initial = new THREE.DataTexture(initial, size, size, THREE.RGBAFormat, THREE.FloatType);
    this.initial.needsUpdate = true;
    this.targets = [0, 1].map(() => new THREE.RenderTarget(size, size, {
      type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    }));
    this.output = new THREE.RenderTarget(size, size, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: true });
    this.output.texture.wrapS = this.output.texture.wrapT = THREE.RepeatWrapping;
    this.output.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.output.texture.name = `ocean-slopes-${length}m`;
    const quad = (node: THREE.Node) => {
      const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, blending: THREE.NoBlending });
      material.fragmentNode = node;
      material.toneMapped = false;
      return new THREE.QuadMesh(material);
    };
    const evolution = { initial: texture(this.initial), pixel: uv().mul(size), size: uint(size), period: float(length), depth: float(options.depth), clock: options.clock };
    this.evolveQuad = quad(evolve({ ...evolution, transport: uint(0) }));
    this.transport = withTransport ? new THREE.RenderTarget(size, size, { type: THREE.HalfFloatType, depthBuffer: false }) : null;
    if (this.transport) {
      this.transport.texture.wrapS = this.transport.texture.wrapT = THREE.RepeatWrapping;
      this.transport.texture.name = `ocean-velocity-acceleration-${length}m`;
    }
    this.transportEvolve = withTransport ? quad(evolve({ ...evolution, transport: uint(1) })) : null;
    this.displacement = size === 512 ? new THREE.RenderTarget(size, size, { type: THREE.HalfFloatType, depthBuffer: false }) : null;
    if (this.displacement) this.displacement.texture.wrapS = this.displacement.texture.wrapT = THREE.RepeatWrapping;
    this.displacementEvolve = this.displacement ? quad(evolve({ ...evolution, transport: uint(2) })) : null;
    const bits = Math.log2(size);
    for (let axis = 0; axis < 2; axis++) for (let stage = 0; stage < bits; stage++) {
      const index = axis * bits + stage;
      this.stages.push(quad(inverseStage({ source: texture(this.targets[index % 2].texture), pixel: uv().mul(size), axis: uint(axis), stage: uint(stage), bits: uint(bits) })));
    }
    const transformed = texture(this.targets[0].texture, uv());
    const slopes = transformed.xy;
    this.resolveQuad = quad(vec4(slopes, slopes.dot(slopes), transformed.z));
    this.transportResolve = withTransport ? quad(vec4(transformed.xy, transformed.z, transformed.z.pow(2))) : null;
  }

  reseed(): void {
    const next = new SpectralBand(this.length, this.minK, this.maxK, this.options, this.seed, this.size);
    (this.initial.image.data as Float32Array).set(next.initial.image.data as Float32Array);
    this.initial.needsUpdate = true;
    this.expectedSlopeVariance = next.expectedSlopeVariance;
    this.accelerationVariance = next.accelerationVariance;
    this.accelerationRateVariance = next.accelerationRateVariance;
    next.dispose();
  }

  update(): void {
    const renderer = this.options.renderer;
    renderer.setRenderTarget(this.targets[0]);
    this.evolveQuad.render(renderer);
    this.stages.forEach((quad, i) => {
      renderer.setRenderTarget(this.targets[(i + 1) % 2]);
      quad.render(renderer);
    });
    renderer.setRenderTarget(this.output);
    this.resolveQuad.render(renderer);
    if (this.transport && this.transportEvolve && this.transportResolve) {
      renderer.setRenderTarget(this.targets[0]);
      this.transportEvolve.render(renderer);
      this.stages.forEach((quad, i) => {
        renderer.setRenderTarget(this.targets[(i + 1) % 2]);
        quad.render(renderer);
      });
      renderer.setRenderTarget(this.transport);
      this.transportResolve.render(renderer);
    }
    if (this.displacement && this.displacementEvolve && this.transportResolve) {
      renderer.setRenderTarget(this.targets[0]);
      this.displacementEvolve.render(renderer);
      this.stages.forEach((quad, i) => {
        renderer.setRenderTarget(this.targets[(i + 1) % 2]);
        quad.render(renderer);
      });
      renderer.setRenderTarget(this.displacement);
      this.transportResolve.render(renderer);
    }
  }

  dispose(): void {
    for (const target of [...this.targets, this.output]) target.dispose();
    for (const quad of [this.evolveQuad, ...this.stages, this.resolveQuad]) (quad.material as THREE.Material).dispose();
    this.initial.dispose();
    this.transport?.dispose();
    this.displacement?.dispose();
    for (const quad of [this.transportEvolve, this.transportResolve, this.displacementEvolve]) if (quad) (quad.material as THREE.Material).dispose();
  }
}

export class OceanDetail {
  readonly bands: SpectralBand[] = [];
  readonly geometryBand: SpectralBand | null;
  readonly unresolvedVariance = uniform(0);
  readonly breakingThreshold = uniform(1e6);
  readonly breakingWidth = uniform(0.01);
  whitecapFraction = 0;
  private readonly tailMinK: number;

  constructor(private readonly options: DetailOptions) {
    let minK = 2 * Math.PI / options.longestWavelength;
    this.geometryBand = options.domainLength ? new SpectralBand(options.domainLength, 2 * Math.PI / options.domainLength, minK, options, 239, 512, true) : null;
    for (const [i, length] of [37, 4.3, 0.47].entries()) {
      const maxK = 2 * Math.PI * 256 / (8 * length);
      if (maxK <= minK) continue;
      this.bands.push(new SpectralBand(length, minK, maxK, options, 317 + i * 107, 256, i === 0));
      minK = maxK;
    }
    this.tailMinK = minK;
    this.updateTail();
  }

  private updateTail(): void {
    let variance = 0;
    if (this.options.windSpeed > 0) for (let i = 0; i < 256; i++) {
      const step = Math.log(5000 / this.tailMinK) / 256;
      const k = this.tailMinK * Math.exp((i + 0.5) * step);
      variance += eckvSpectrum(k, this.options.windSpeed, this.options.inverseWaveAge).slope * k * step;
    }
    this.unresolvedVariance.value = variance;
    const transportBands = [this.geometryBand, ...this.bands].filter(band => band?.transport);
    const acceleration = transportBands.reduce((sum, band) => sum + band!.accelerationVariance, 0);
    const rate = transportBands.reduce((sum, band) => sum + band!.accelerationRateVariance, 0);
    this.whitecapFraction = Math.min(0.5, 3.84e-6 * this.options.windSpeed ** 3.41);
    const alpha = Math.exp(-Math.sqrt(acceleration / Math.max(rate, 1e-12)) / 2.8);
    const probability = this.whitecapFraction * (1 - alpha) / (1 - this.whitecapFraction * alpha);
    let low = 0, high = 8;
    for (let i = 0; i < 40; i++) {
      const z = (low + high) / 2;
      const t = 1 / (1 + 0.2316419 * z);
      const tail = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI)
        * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
      if (tail > probability) low = z; else high = z;
    }
    this.breakingThreshold.value = acceleration > 0 ? (low + high) / 2 * Math.sqrt(acceleration) : 1e6;
    this.breakingWidth.value = Math.max(0.01, Math.sqrt(acceleration) * 0.15);
  }

  setWind(speed: number, direction: number): void {
    this.options.windSpeed = speed;
    this.options.windDirection = direction;
    this.geometryBand?.reseed();
    this.bands.forEach(band => band.reseed());
    this.updateTail();
  }

  geometry(xz: THREE.Node): THREE.Node {
    const band = this.geometryBand;
    if (!band) throw new Error('Ocean geometry spectrum needs a domain length');
    return Fn(() => {
      const q = vec2(xz).toVar();
      const displacement = (p: THREE.Node) => texture(band.displacement!.texture, vec2(p).div(band.length).add(0.5 / band.size)).level(float(0)).xy;
      Loop(8, () => { q.assign(vec2(xz).sub(displacement(q))); });
      const cell = band.length / band.size;
      const dx = displacement(q.add(vec2(cell, 0))).sub(displacement(q.sub(vec2(cell, 0)))).div(2 * cell);
      const dz = displacement(q.add(vec2(0, cell))).sub(displacement(q.sub(vec2(0, cell)))).div(2 * cell);
      const determinant = float(1).add(dx.x).mul(float(1).add(dz.y)).sub(dx.y.mul(dz.x));
      const sample = texture(band.output.texture, q.div(band.length).add(0.5 / band.size)).level(float(0));
      const slopeX = sample.x.mul(float(1).add(dz.y)).sub(sample.y.mul(dx.y)).div(max(determinant, 0.05));
      const slopeZ = sample.y.mul(float(1).add(dx.x)).sub(sample.x.mul(dz.x)).div(max(determinant, 0.05));
      return vec3(sample.w, slopeX, slopeZ);
    })();
  }

  transport(xz: THREE.Node): THREE.Node {
    return Fn(() => {
      const result = vec3(0).toVar();
      for (const band of [this.geometryBand, ...this.bands]) {
        if (!band?.transport) continue;
        result.addAssign(texture(band.transport.texture, vec2(xz).div(band.length).add(0.5 / band.size)).level(float(0)).xyz);
      }
      return result;
    })();
  }

  sample(xz: THREE.Node): THREE.Node {
    return Fn(() => {
      const slope = vec2(0).toVar();
      const variance = float(this.unresolvedVariance).toVar();
      for (const band of this.bands) {
        const value = texture(band.output.texture, vec2(xz).div(band.length).add(0.5 / band.size));
        slope.addAssign(value.xy);
        variance.addAssign(max(value.z.sub(value.xy.dot(value.xy)), 0));
      }
      return vec3(slope, variance);
    })();
  }

  update(): void {
    const renderer = this.options.renderer;
    const target = renderer.getRenderTarget(), mrt = renderer.getMRT();
    try {
      renderer.setMRT(null);
      this.geometryBand?.update();
      for (const band of this.bands) band.update();
    } finally {
      renderer.setRenderTarget(target); renderer.setMRT(mrt);
    }
  }

  dispose(): void { this.geometryBand?.dispose(); this.bands.forEach(band => band.dispose()); }
}
