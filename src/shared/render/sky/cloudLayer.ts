import * as THREE from 'three/webgpu';
import { Fn, If, float, fract, globalId, length, max, min, mix, normalize, screenUV, select, texture, textureStore, uniform, uvec2, vec2, vec3, vec4 } from 'three/tsl';
import { CloudNoiseVolumes } from './cloudNoise.ts';
import { CloudUniforms, DEFAULT_CLOUD_SETTINGS, layerSegment, type CloudSettings } from './cloudDensity.ts';
import { marchCloudLayer, type CloudLightContext } from './cloudLighting.ts';
import type { SkyAtmosphere } from './skyAtmosphere.ts';
import { readTransmittance } from './lutMapping.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const WORKGROUP = 8;
const MARCH_STEPS = 48;
const MAX_PIXEL_RATIO = 2;
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
  readonly volumes: CloudNoiseVolumes;
  private readonly targets: [THREE.StorageTexture, THREE.StorageTexture];
  private readonly kernels: [N, N];
  private readonly parity = uniform(0);
  private readonly frame = uniform(0);
  private readonly jitter = uniform(new THREE.Vector2());
  private readonly inverseProjection = uniform(new THREE.Matrix4());
  private readonly cameraWorld = uniform(new THREE.Matrix4());
  private readonly previousViewProjection = uniform(new THREE.Matrix4());
  private readonly historyValid = uniform(0);
  private readonly active = uniform(new THREE.Vector2(1, 1));
  private readonly capacity: THREE.Vector2;
  private readonly drawingBuffer = new THREE.Vector2();
  private settingsSeen = '';
  private lastFrameUpdated = -2;
  private frameCount = 0;
  private windKm = new THREE.Vector2();
  private lastTime = -1;
  private generated = false;

  constructor(private readonly renderer: THREE.WebGPURenderer, private readonly sky: SkyAtmosphere, settings: Partial<CloudSettings> = {}) {
    this.settings = { ...DEFAULT_CLOUD_SETTINGS, ...settings };
    this.volumes = new CloudNoiseVolumes(renderer);
    this.capacity = CloudLayer.capacityFor(this.settings.resolutionDivisor);
    this.targets = [target(this.capacity.x, this.capacity.y), target(this.capacity.x, this.capacity.y)];
    this.kernels = [this.kernel(0), this.kernel(1)];
  }

  /* @important The targets are sized once for the largest drawing buffer this display can produce,
     and the traced area is a uniform. A resize, a full-screen toggle or a pixel-ratio change then
     only moves that uniform; resizing the textures instead would rebuild both kernels and the
     background node that samples them. */
  private static capacityFor(divisor: number): THREE.Vector2 {
    const ratio = Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1);
    const longest = Math.max(window.screen.width, window.screen.height, window.innerWidth, window.innerHeight) * ratio;
    return new THREE.Vector2(Math.ceil(longest / divisor), Math.ceil(longest / divisor));
  }

  update(camera: THREE.PerspectiveCamera, timeSeconds: number): void {
    if (!this.generated) { this.volumes.generate(); this.generated = true; }
    this.uniforms.write(this.settings, this.sky.parameters.groundRadiusKm);
    this.invalidateHistoryWhenStale();
    this.advanceWind(camera, timeSeconds);
    this.jitter.value.set(halton(this.frameCount % HALTON_LENGTH + 1, 2) - 0.5, halton(this.frameCount % HALTON_LENGTH + 1, 3) - 0.5);
    this.inverseProjection.value.copy(camera.projectionMatrixInverse);
    this.cameraWorld.value.copy(camera.matrixWorld);
    this.frame.value = this.frameCount % 64;
    const write = this.frameCount % 2;
    this.parity.value = write;
    const { x: width, y: height } = this.active.value;
    this.renderer.compute(this.kernels[write], [Math.ceil(width / WORKGROUP), Math.ceil(height / WORKGROUP), 1]);
    this.previousViewProjection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.historyValid.value = 1;
    this.lastFrameUpdated = this.frameCount;
    this.frameCount++;
  }

  composite(sky: N): N {
    const uv = this.activeUv(screenUV);
    const current = select(this.parity.lessThan(0.5), texture(this.targets[0], uv).level(float(0)), texture(this.targets[1], uv).level(float(0)));
    return sky.mul(current.a).add(current.rgb);
  }

  /* @important The history is dropped whenever it no longer describes this frame: the traced area
     changed size, any setting changed (coverage, altitude, wind, density), or the layer skipped
     frames while switched off. A 0.9 history blended across any of those shows the old clouds for
     about twenty frames. */
  private invalidateHistoryWhenStale(): void {
    const buffer = this.renderer.getDrawingBufferSize(this.drawingBuffer);
    const width = Math.min(this.capacity.x, Math.max(1, Math.ceil(buffer.x / this.settings.resolutionDivisor)));
    const height = Math.min(this.capacity.y, Math.max(1, Math.ceil(buffer.y / this.settings.resolutionDivisor)));
    const settings = JSON.stringify(this.settings);
    const resized = width !== this.active.value.x || height !== this.active.value.y;
    const skipped = this.lastFrameUpdated !== this.frameCount - 1;
    if (resized || skipped || settings !== this.settingsSeen) this.historyValid.value = 0;
    this.active.value.set(width, height);
    this.settingsSeen = settings;
  }

  private activeUv(uv: N): N {
    const capacity = vec2(this.capacity.x, this.capacity.y);
    const lastTexelCentre = this.active.sub(0.5).div(capacity);
    return min(uv.mul(this.active).div(capacity), lastTexelCentre);
  }

  /* @important The air between the camera and the cloud, from the atmosphere's own transmittance
     texture: T(camera to top) / T(cloud to top) along the ray, flipped for rays that point down. A
     fixed 45 km exponential used to dissolve every distant cloud into whatever lay behind it, so a
     viewer at 12 km lost the whole layer below the horizon into bare ground. The air's own glow is
     left to the sky behind, which already carries it: rgb is attenuated, alpha reveals that much
     more sky. */
  private airTransmittance(origin: N, direction: N, distance: N): N {
    const source = this.sky.luts.transmittanceSource;
    const point = origin.add(direction.mul(distance));
    const viewRadius = length(origin);
    const pointRadius = length(point);
    const viewCos = direction.dot(origin.div(viewRadius));
    const pointCos = direction.dot(point.div(pointRadius));
    const upward = readTransmittance(source, viewRadius, viewCos).div(max(readTransmittance(source, pointRadius, pointCos), vec3(1e-4)));
    const downward = readTransmittance(source, pointRadius, pointCos.negate()).div(max(readTransmittance(source, viewRadius, viewCos.negate()), vec3(1e-4)));
    return select(viewCos.greaterThanEqual(0), upward, downward).clamp(0, 1);
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
    const uv = pixel.add(0.5).add(this.jitter).div(this.active);
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
    return { value: texture(read, this.activeUv(uv)).level(float(0)), weight };
  }

  lightContext(): CloudLightContext {
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

  /* @important The cloud's light is dimmed by the mean air transmittance, not the per-channel one. The
     per-channel value reddens the cloud as it should, but the blue light the same air scatters toward
     the camera is never added here, so distant clouds at noon came out as a yellow-brown band along the
     horizon (shots/highsun/before.png against greyair.png). The grey dimming plus the sky revealed
     through the alpha keeps the haze blue-white. */
  traceDirection(direction: N, jitter: N, steps: number): N {
    const origin = vec3(0, this.sky.luts.viewRadius, 0);
    const segment = layerSegment(this.uniforms, origin, direction, this.sky.luts.atmosphere.groundRadius);
    const march = marchCloudLayer(this.lightContext(), { origin, direction, start: segment.start, end: segment.end, jitter, steps });
    const air = this.airTransmittance(origin, direction, march.depth);
    const airMean = air.x.add(air.y).add(air.z).div(3);
    const luminance = select(segment.valid, march.luminance.mul(airMean), vec3(0));
    const transmittance = select(segment.valid, mix(float(1), march.transmittance, airMean), float(1));
    return vec4(luminance, transmittance);
  }

  private kernel(writeIndex: number): N {
    const write = this.targets[writeIndex];
    const read = this.targets[1 - writeIndex];
    return Fn(() => {
      If(float(globalId.x).lessThan(this.active.x).and(float(globalId.y).lessThan(this.active.y)), () => {
        const pixel = vec2(globalId.xy);
        const direction = this.viewDirection(pixel);
        const traced = this.traceDirection(direction, interleavedGradientNoise(pixel, this.frame), MARCH_STEPS);
        const history = this.history(read, direction);
        textureStore(write, uvec2(globalId.x, globalId.y), mix(traced, history.value, history.weight));
      });
    })().computeKernel([WORKGROUP, WORKGROUP, 1]).setName(`Clouds ${writeIndex}`);
  }
}
