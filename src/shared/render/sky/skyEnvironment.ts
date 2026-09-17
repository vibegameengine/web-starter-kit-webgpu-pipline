import * as THREE from 'three/webgpu';
import { Fn, If, cos, float, globalId, mix, sin, texture, textureStore, uniform, uvec2, vec2, vec3, vec4 } from 'three/tsl';
import type { SkyAtmosphere } from './skyAtmosphere.ts';
import type { CloudLayer } from './cloudLayer.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const WORKGROUP = 8;
const CLOUD_WIDTH = 512;
const CLOUD_HEIGHT = 256;
const CLOUD_STEPS = 24;
const CLOUD_JITTER = 0.5;

function equirectDirection(uv: N): N {
  const azimuth = uv.x.sub(0.5).mul(2 * Math.PI);
  const latitude = uv.y.sub(0.5).mul(Math.PI);
  return vec3(cos(azimuth).mul(cos(latitude)), sin(latitude), sin(azimuth).mul(cos(latitude)));
}

/* @important The panorama every lighting consumer already holds - the bake's sky rays, the probes,
   the reflections' miss colour, the fog's ambient - is rewritten in place from the atmosphere, so
   nothing has to be rebound and the sky the frame shows is the sky that lights it. The sun disc is
   left out on purpose: every one of those consumers traces the sun as an analytic light, and a disc
   in the panorama would count it twice. Rows are written top first because the loader marks the
   panorama flipY. */
export class SkyEnvironment {
  private readonly storage: THREE.StorageTexture;
  private readonly kernel: THREE.ComputeNode;
  private readonly cloudTexture: THREE.StorageTexture;
  private readonly cloudKernel: THREE.ComputeNode | null;
  readonly cloudPresence = uniform(0);
  private capturing: Promise<void> | null = null;
  private captures = 0;

  constructor(private readonly renderer: THREE.WebGPURenderer, sky: SkyAtmosphere, private readonly target: THREE.DataTexture, clouds: CloudLayer | null = null) {
    const { width, height } = target.image as { width: number; height: number };
    this.storage = new THREE.StorageTexture(width, height);
    this.storage.type = target.type === THREE.FloatType ? THREE.FloatType : THREE.HalfFloatType;
    this.storage.generateMipmaps = false;
    this.cloudTexture = new THREE.StorageTexture(CLOUD_WIDTH, CLOUD_HEIGHT);
    this.cloudTexture.type = THREE.HalfFloatType;
    this.cloudTexture.generateMipmaps = false;
    this.cloudKernel = clouds ? this.buildCloudKernel(clouds) : null;
    this.kernel = Fn(() => {
      If(globalId.x.lessThan(width).and(globalId.y.lessThan(height)), () => {
        const uv = vec2(float(globalId.x).add(0.5).div(width), float(1).sub(float(globalId.y).add(0.5).div(height)));
        const clear = sky.skyLuminance(equirectDirection(uv));
        const cloud = texture(this.cloudTexture, uv).level(float(0));
        const cloudy = clear.mul(cloud.a).add(cloud.rgb);
        textureStore(this.storage, uvec2(globalId.x, globalId.y), vec4(mix(clear, cloudy, this.cloudPresence), 1));
      });
    })().computeKernel([WORKGROUP, WORKGROUP, 1]).setName('Sky Environment');
  }

  /* @important The clouds are traced once more for the panorama, at 512x256 and 24 steps, rather than
     sampled from the screen-space layer: the lighting needs the whole sphere, including every
     direction behind the camera, and a quarter-degree texel is finer than anything the probes and the
     bake resolve. Without this an overcast sky lit the scene as a clear one. */
  private buildCloudKernel(clouds: CloudLayer): THREE.ComputeNode {
    return Fn(() => {
      If(globalId.x.lessThan(CLOUD_WIDTH).and(globalId.y.lessThan(CLOUD_HEIGHT)), () => {
        const uv = vec2(globalId.xy).add(0.5).div(vec2(CLOUD_WIDTH, CLOUD_HEIGHT));
        textureStore(this.cloudTexture, uvec2(globalId.x, globalId.y), clouds.traceDirection(equirectDirection(uv), float(CLOUD_JITTER), CLOUD_STEPS));
      });
    })().computeKernel([WORKGROUP, WORKGROUP, 1]).setName('Sky Environment clouds');
  }

  summary(): { captures: number; version: number; rowMeans: number[] } {
    const { width, height } = this.target.image as { width: number; height: number };
    const data = this.target.image.data as ArrayLike<number>;
    const half = data instanceof Uint16Array;
    const rowMean = (row: number) => {
      let sum = 0;
      for (let x = 0; x < width; x++) sum += half ? THREE.DataUtils.fromHalfFloat(data[(row * width + x) * 4 + 2]) : data[(row * width + x) * 4 + 2];
      return +(sum / width).toFixed(4);
    };
    return { captures: this.captures, version: this.target.version, rowMeans: [0, height / 4, height / 2 - 2, (3 * height) / 4, height - 1].map((row) => rowMean(Math.floor(row))) };
  }

  get busy(): boolean {
    return this.capturing !== null;
  }

  capture(): Promise<void> {
    this.capturing ??= this.write().finally(() => { this.capturing = null; });
    return this.capturing;
  }

  private async write(): Promise<void> {
    const { width, height } = this.target.image as { width: number; height: number };
    if (this.cloudKernel && this.cloudPresence.value > 0) this.renderer.compute(this.cloudKernel, [Math.ceil(CLOUD_WIDTH / WORKGROUP), Math.ceil(CLOUD_HEIGHT / WORKGROUP), 1]);
    this.renderer.compute(this.kernel, [Math.ceil(width / WORKGROUP), Math.ceil(height / WORKGROUP), 1]);
    const wrapper = new THREE.RenderTarget(width, height);
    const ownTexture = wrapper.texture;
    wrapper.textures = [this.storage];
    try {
      const pixels = await this.renderer.readRenderTargetPixelsAsync(wrapper, 0, 0, width, height);
      (this.target.image.data as unknown as { set(source: ArrayLike<number>): void }).set(pixels as ArrayLike<number>);
    } finally {
      wrapper.textures = [ownTexture];
      wrapper.dispose();
    }
    this.target.needsUpdate = true;
    this.captures++;
  }
}
