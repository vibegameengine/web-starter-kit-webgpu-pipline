import * as THREE from 'three/webgpu';
import { Fn, If, cos, float, globalId, sin, textureStore, uvec2, vec2, vec3, vec4 } from 'three/tsl';
import type { SkyAtmosphere } from './skyAtmosphere.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const WORKGROUP = 8;

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
  private capturing: Promise<void> | null = null;
  private captures = 0;

  constructor(private readonly renderer: THREE.WebGPURenderer, sky: SkyAtmosphere, private readonly target: THREE.DataTexture) {
    const { width, height } = target.image as { width: number; height: number };
    this.storage = new THREE.StorageTexture(width, height);
    this.storage.type = target.type === THREE.FloatType ? THREE.FloatType : THREE.HalfFloatType;
    this.storage.generateMipmaps = false;
    this.kernel = Fn(() => {
      If(globalId.x.lessThan(width).and(globalId.y.lessThan(height)), () => {
        const uv = vec2(float(globalId.x).add(0.5).div(width), float(1).sub(float(globalId.y).add(0.5).div(height)));
        textureStore(this.storage, uvec2(globalId.x, globalId.y), vec4(sky.skyLuminance(equirectDirection(uv)), 1));
      });
    })().computeKernel([WORKGROUP, WORKGROUP, 1]).setName('Sky Environment');
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
