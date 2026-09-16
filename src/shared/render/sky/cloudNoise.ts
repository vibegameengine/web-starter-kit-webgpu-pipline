import * as THREE from 'three/webgpu';
import { Fn, If, Loop, dot, float, floor, globalId, hash, length, min, mix, mod, textureStore, uniform, uvec3, vec3, vec4 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const SHAPE_SIZE = 96;
const DETAIL_SIZE = 32;
const SLICES_PER_DISPATCH = 8;
const WORKGROUP = 8;

function wrappedCellSeed(cell: N, period: number): N {
  const wrapped = mod(cell.add(period), period);
  return wrapped.x.add(wrapped.y.mul(period)).add(wrapped.z.mul(period * period));
}

function cellVector(seed: N): N {
  const base = seed.mul(3);
  return vec3(hash(base), hash(base.add(1)), hash(base.add(2)));
}

function periodicWorley(point: N, period: number): N {
  const cell = floor(point);
  const local = point.sub(cell);
  const nearest = float(8).toVar();
  Loop(27, ({ i }: { i: N }) => {
    const offset = vec3(float(i.mod(3)).sub(1), float(i.div(3).mod(3)).sub(1), float(i.div(9)).sub(1));
    const feature = cellVector(wrappedCellSeed(cell.add(offset), period));
    nearest.assign(min(nearest, length(offset.add(feature).sub(local))));
  });
  return float(1).sub(nearest.clamp(0, 1));
}

function cornerGradient(cell: N, corner: N, period: number): N {
  return cellVector(wrappedCellSeed(cell.add(corner), period)).mul(2).sub(1);
}

function periodicGradientNoise(point: N, period: number): N {
  const cell = floor(point);
  const local = point.sub(cell);
  const fade = local.mul(local).mul(local).mul(local.mul(local.mul(6).sub(15)).add(10));
  const corner = (x: number, y: number, z: number) => dot(cornerGradient(cell, vec3(x, y, z), period), local.sub(vec3(x, y, z)));
  const bottom = mix(mix(corner(0, 0, 0), corner(1, 0, 0), fade.x), mix(corner(0, 1, 0), corner(1, 1, 0), fade.x), fade.y);
  const top = mix(mix(corner(0, 0, 1), corner(1, 0, 1), fade.x), mix(corner(0, 1, 1), corner(1, 1, 1), fade.x), fade.y);
  return mix(bottom, top, fade.z).mul(0.5).add(0.5).clamp(0, 1);
}

function worleyOctaves(unit: N, base: number): N {
  return periodicWorley(unit.mul(base), base).mul(0.625)
    .add(periodicWorley(unit.mul(base * 2), base * 2).mul(0.25))
    .add(periodicWorley(unit.mul(base * 4), base * 4).mul(0.125));
}

function gradientOctaves(unit: N, base: number): N {
  return periodicGradientNoise(unit.mul(base), base).mul(0.5)
    .add(periodicGradientNoise(unit.mul(base * 2), base * 2).mul(0.3))
    .add(periodicGradientNoise(unit.mul(base * 4), base * 4).mul(0.2));
}

export function remap(value: N, low: N, high: N): N {
  return value.sub(low).div(high.sub(low).max(1e-4)).clamp(0, 1);
}

function volume(name: string, size: number): THREE.Storage3DTexture {
  const texture = new THREE.Storage3DTexture(size, size, size);
  texture.name = name;
  texture.type = THREE.HalfFloatType;
  texture.format = THREE.RGBAFormat;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.generateMipmaps = false;
  return texture;
}

/* @important Two tiling volumes in the manner of Schneider, "The Real-time Volumetric Cloudscapes of
   Horizon Zero Dawn" (SIGGRAPH 2015): the shape volume holds a Perlin-Worley billow in red (gradient
   noise dilated by inverted Worley, so puffs are round and connected) and Worley octaves in green
   that carve it; the detail volume holds finer Worley that erodes edges into wisps. Every lattice is
   hashed modulo its own period, so both volumes wrap without a seam and can repeat over kilometres. */
export class CloudNoiseVolumes {
  readonly shape = volume('cloudShape', SHAPE_SIZE);
  readonly detail = volume('cloudDetail', DETAIL_SIZE);
  private readonly sliceOffset = uniform(0);

  constructor(private readonly renderer: THREE.WebGPURenderer) {}

  generate(): void {
    this.fill(this.shapeKernel(), SHAPE_SIZE);
    this.fill(this.detailKernel(), DETAIL_SIZE);
  }

  private fill(kernel: N, size: number): void {
    for (let slice = 0; slice < size; slice += SLICES_PER_DISPATCH) {
      this.sliceOffset.value = slice;
      this.renderer.compute(kernel, [Math.ceil(size / WORKGROUP), Math.ceil(size / WORKGROUP), 1]);
    }
  }

  private eachVoxel(size: number, body: (unit: N, voxel: N) => N): N {
    return Fn(() => {
      const voxel = uvec3(globalId.x, globalId.y, globalId.z.add(this.sliceOffset.toUint()));
      If(globalId.x.lessThan(size).and(globalId.y.lessThan(size)).and(voxel.z.lessThan(size)), () => {
        const unit = vec3(voxel).add(0.5).div(size);
        body(unit, voxel);
      });
    })().computeKernel([WORKGROUP, WORKGROUP, SLICES_PER_DISPATCH]);
  }

  private shapeKernel(): N {
    return this.eachVoxel(SHAPE_SIZE, (unit, voxel) => {
      const billow = worleyOctaves(unit, 4);
      const perlinWorley = mix(billow, float(1), gradientOctaves(unit, 4));
      const carve = worleyOctaves(unit, 8);
      textureStore(this.shape, voxel, vec4(perlinWorley, carve, gradientOctaves(unit, 2), 1));
    }).setName('Cloud shape volume');
  }

  private detailKernel(): N {
    return this.eachVoxel(DETAIL_SIZE, (unit, voxel) => {
      textureStore(this.detail, voxel, vec4(worleyOctaves(unit, 2), 0, 0, 1));
    }).setName('Cloud detail volume');
  }
}

