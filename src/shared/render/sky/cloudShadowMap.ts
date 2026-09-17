import * as THREE from 'three/webgpu';
import { Fn, If, Loop, exp, float, globalId, select, texture, textureStore, uniform, uvec2, vec2, vec3, vec4 } from 'three/tsl';
import { sphereDistances } from './atmosphereMedium.ts';
import { cloudDensity } from './cloudDensity.ts';
import type { CloudLayer } from './cloudLayer.ts';
import type { SkyAtmosphere } from './skyAtmosphere.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const SIZE = 512;
const EXTENT_KM = 8;
const STEPS = 12;
const WORKGROUP = 8;
const METRES_PER_KM = 1000;
const RECEIVER_LIFT_KM = 0.001;

/* @important Sunlight reaching the ground through the cloud layer, as a top-down map centred on the
   camera: every texel is a ground point marched toward the sun through the layer, and the value is
   the transmittance of that path. It is read inside the sun's shadow filter, so every receiver of the
   sun darkens under a cloud without touching a single material, and the edges move with the wind.
   8 km at 512 texels is 16 m a texel: cloud shadows are soft at that scale anyway, because a cloud's
   penumbra from a 0.53 degree sun at 1.5 km is already 14 m wide. */
export class CloudShadowMap {
  readonly texture: THREE.StorageTexture;
  readonly centre = uniform(new THREE.Vector2());
  readonly strength = uniform(0);
  private readonly kernel: N;

  constructor(private readonly renderer: THREE.WebGPURenderer, sky: SkyAtmosphere, clouds: CloudLayer) {
    this.texture = new THREE.StorageTexture(SIZE, SIZE);
    this.texture.type = THREE.HalfFloatType;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.kernel = this.buildKernel(sky, clouds);
  }

  update(camera: THREE.Camera, enabled: boolean): void {
    this.strength.value = enabled ? 1 : 0;
    if (!enabled) return;
    this.centre.value.set(camera.position.x, camera.position.z);
    this.renderer.compute(this.kernel, [Math.ceil(SIZE / WORKGROUP), Math.ceil(SIZE / WORKGROUP), 1]);
  }

  sample(worldPosition: N): N {
    const uv = vec2(worldPosition.x, worldPosition.z).sub(this.centre).div(EXTENT_KM * METRES_PER_KM).add(0.5);
    const inside = uv.x.greaterThan(0).and(uv.x.lessThan(1)).and(uv.y.greaterThan(0)).and(uv.y.lessThan(1));
    const transmittance = select(inside, texture(this.texture, uv).level(float(0)).r, float(1));
    return float(1).sub(this.strength.mul(float(1).sub(transmittance)));
  }

  private buildKernel(sky: SkyAtmosphere, clouds: CloudLayer): N {
    return Fn(() => {
      If(globalId.x.lessThan(SIZE).and(globalId.y.lessThan(SIZE)), () => {
        const offset = vec2(globalId.xy).add(0.5).div(SIZE).sub(0.5).mul(EXTENT_KM);
        const ground = vec3(offset.x, sky.luts.atmosphere.groundRadius.add(RECEIVER_LIFT_KM), offset.y);
        const toSun = vec3(sky.sunDirection);
        const start = sphereDistances(ground, toSun, clouds.uniforms.bottomRadius).far;
        const end = sphereDistances(ground, toSun, clouds.uniforms.topRadius).far.min(start.add(clouds.uniforms.maxDistance));
        const segment = end.sub(start).div(STEPS);
        const depth = float(0).toVar();
        Loop(STEPS, ({ i }: { i: N }) => {
          const position = ground.add(toSun.mul(start.add(float(i).add(0.5).mul(segment))));
          depth.addAssign(cloudDensity(clouds.volumes, clouds.uniforms, position, false).mul(segment));
        });
        const sunUp = toSun.y.greaterThan(0);
        textureStore(this.texture, uvec2(globalId.x, globalId.y), vec4(select(sunUp, exp(depth.negate()), float(1)), 0, 0, 1));
      });
    })().computeKernel([WORKGROUP, WORKGROUP, 1]).setName('Cloud shadow map');
  }
}
