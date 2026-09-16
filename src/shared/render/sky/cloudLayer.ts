import * as THREE from 'three/webgpu';
import { Fn, If, exp, float, fract, globalId, mix, normalize, screenUV, select, texture, textureStore, uniform, uvec2, vec2, vec3, vec4 } from 'three/tsl';
import { CloudNoiseVolumes } from './cloudNoise.ts';
import { CloudUniforms, DEFAULT_CLOUD_SETTINGS, layerSegment, type CloudSettings } from './cloudDensity.ts';
import { marchCloudLayer, type CloudLightContext } from './cloudLighting.ts';
import type { SkyAtmosphere } from './skyAtmosphere.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const WORKGROUP = 8;
const MARCH_STEPS = 48;
const HAZE_DISTANCE_KM = 45;
const SECONDS_PER_MINUTE = 60;
const HALTON_LENGTH = 16;

function halton(index: number, base: number): number {
  let fraction = 1;
  let result = 0;
  for (let i = index; i > 0; i = Math.floor(i / base)) {
    fraction /= base;
    result += fraction * (i % base);
  }
  return result;
}

function target(width: number, height: number): THREE.StorageTexture {
  const texture = new THREE.StorageTexture(width, height);
  texture.type = THREE.HalfFloatType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  return texture;
}

/* @important Interleaved gradient noise, Jimenez, "Next Generation Post Processing in Call of Duty:
   Advanced Warfare" (SIGGRAPH 2014), stepped by frame, decorrelates the march start per pixel; the
   history then integrates what 48 steps alone cannot resolve. */
function interleavedGradientNoise(pixel: N, frame: N): N {
  const shifted = pixel.add(frame.mul(5.588238));
  return fract(fract(shifted.dot(vec2(0.06711056, 0.00583715))).mul(52.9829189));
}

export class CloudLayer {
  readonly settings: CloudSettings;
  readonly uniforms = new CloudUniforms();
  private readonly volumes: CloudNoiseVolumes;
  private readonly targets: [THREE.StorageTexture, THREE.StorageTexture];
  private readonly kernels: [N, N];
  private readonly parity = uniform(0);
  private readonly frame = uniform(0);
  private readonly jitter = uniform(new THREE.Vector2());
  private readonly inverseProjection = uniform(new THREE.Matrix4());
  private readonly cameraWorld = uniform(new THREE.Matrix4());
  private readonly previousViewProjection = uniform(new THREE.Matrix4());
  private readonly historyValid = uniform(0);
  private readonly width: number;
  private readonly height: number;
  private frameCount = 0;
  private windKm = new THREE.Vector2();
  private lastTime = -1;
  private generated = false;

  constructor(private readonly renderer: THREE.WebGPURenderer, private readonly sky: SkyAtmosphere, settings: Partial<CloudSettings> = {}) {
    this.settings = { ...DEFAULT_CLOUD_SETTINGS, ...settings };
    this.volumes = new CloudNoiseVolumes(renderer);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.width = Math.max(64, Math.ceil(size.x / this.settings.resolutionDivisor));
    this.height = Math.max(36, Math.ceil(size.y / this.settings.resolutionDivisor));
    this.targets = [target(this.width, this.height), target(this.width, this.height)];
    this.kernels = [this.kernel(0), this.kernel(1)];
  }

  update(camera: THREE.PerspectiveCamera, timeSeconds: number): void {
    if (!this.generated) { this.volumes.generate(); this.generated = true; }
    this.uniforms.write(this.settings, this.sky.parameters.groundRadiusKm);
    this.advanceWind(camera, timeSeconds);
    this.jitter.value.set(halton(this.frameCount % HALTON_LENGTH + 1, 2) - 0.5, halton(this.frameCount % HALTON_LENGTH + 1, 3) - 0.5);
    this.inverseProjection.value.copy(camera.projectionMatrixInverse);
    this.cameraWorld.value.copy(camera.matrixWorld);
    this.frame.value = this.frameCount % 64;
    const write = this.frameCount % 2;
    this.parity.value = write;
    this.renderer.compute(this.kernels[write], [Math.ceil(this.width / WORKGROUP), Math.ceil(this.height / WORKGROUP), 1]);
    this.previousViewProjection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.historyValid.value = 1;
    this.frameCount++;
  }

  composite(sky: N): N {
    const current = select(this.parity.lessThan(0.5), texture(this.targets[0], screenUV).level(float(0)), texture(this.targets[1], screenUV).level(float(0)));
    return sky.mul(current.a).add(current.rgb);
  }

  private advanceWind(camera: THREE.Camera, timeSeconds: number): void {
    const elapsed = this.lastTime < 0 ? 0 : Math.min(0.25, timeSeconds - this.lastTime);
    this.lastTime = timeSeconds;
    const heading = THREE.MathUtils.degToRad(this.settings.windHeadingDeg);
    const distance = (this.settings.windSpeedKmPerMinute / SECONDS_PER_MINUTE) * elapsed;
    this.windKm.x += Math.cos(heading) * distance;
    this.windKm.y += Math.sin(heading) * distance;
    this.uniforms.offset.value.set(camera.position.x / 1000 - this.windKm.x, 0, camera.position.z / 1000 - this.windKm.y);
  }

  private viewDirection(pixel: N): N {
    const uv = pixel.add(0.5).add(this.jitter).div(vec2(this.width, this.height));
    const clip = vec4(uv.x.mul(2).sub(1), float(1).sub(uv.y.mul(2)), 1, 1);
    const view = this.inverseProjection.mul(clip);
    return normalize(this.cameraWorld.mul(vec4(view.xyz.div(view.w), 0)).xyz);
  }

  private history(read: THREE.StorageTexture, direction: N): { value: N; weight: N } {
    const clip = this.previousViewProjection.mul(vec4(direction, 0));
    const ndc = clip.xy.div(clip.w);
    const uv = vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)));
    const inside = clip.w.greaterThan(0).and(uv.x.greaterThanEqual(0)).and(uv.x.lessThanEqual(1)).and(uv.y.greaterThanEqual(0)).and(uv.y.lessThanEqual(1));
    const weight = select(inside.and(this.historyValid.greaterThan(0.5)), this.uniforms.historyWeight, float(0));
    return { value: texture(read, uv).level(float(0)), weight };
  }

  private lightContext(): CloudLightContext {
    const sky = this.sky;
    const up = sky.skyLuminance(vec3(0, 1, 0));
    const side = sky.skyLuminance(normalize(vec3(sky.sunDirection.x, 0.15, sky.sunDirection.z)));
    const away = sky.skyLuminance(normalize(vec3(sky.sunDirection.x.negate(), 0.15, sky.sunDirection.z.negate())));
    return {
      volumes: this.volumes, clouds: this.uniforms, atmosphere: sky.luts.transmittanceSource,
      sunDirection: sky.sunDirection, sunIlluminance: sky.sunIlluminance,
      ambient: up.mul(0.5).add(side.mul(0.25)).add(away.mul(0.25)),
    };
  }

  private kernel(writeIndex: number): N {
    const write = this.targets[writeIndex];
    const read = this.targets[1 - writeIndex];
    return Fn(() => {
      If(globalId.x.lessThan(this.width).and(globalId.y.lessThan(this.height)), () => {
        const pixel = vec2(globalId.xy);
        const direction = this.viewDirection(pixel);
        const origin = vec3(0, this.sky.luts.viewRadius, 0);
        const segment = layerSegment(this.uniforms, origin, direction, this.sky.luts.atmosphere.groundRadius);
        const march = marchCloudLayer(this.lightContext(), { origin, direction, start: segment.start, end: segment.end, jitter: interleavedGradientNoise(pixel, this.frame), steps: MARCH_STEPS });
        const haze = exp(march.depth.div(HAZE_DISTANCE_KM).negate());
        const luminance = select(segment.valid, march.luminance.mul(haze), vec3(0));
        const transmittance = select(segment.valid, mix(float(1), march.transmittance, haze), float(1));
        const history = this.history(read, direction);
        textureStore(write, uvec2(globalId.x, globalId.y), mix(vec4(luminance, transmittance), history.value, history.weight));
      });
    })().computeKernel([WORKGROUP, WORKGROUP, 1]).setName(`Clouds ${writeIndex}`);
  }
}
