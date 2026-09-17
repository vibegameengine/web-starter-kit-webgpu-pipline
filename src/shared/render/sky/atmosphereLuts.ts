import * as THREE from 'three/webgpu';
import { Fn, If, Loop, exp, float, globalId, length, max, sqrt, textureStore, uniform, uvec2, vec2, vec3, vec4 } from 'three/tsl';
import type { AtmosphereUniforms } from './atmosphereParameters.ts';
import { sampleMedium, sphereDistances } from './atmosphereMedium.ts';
import { skyViewDirection, transmittanceLutParameters, type LutSource } from './lutMapping.ts';
import { groundBounce, marchScattering, type MarchRay } from './scatteringMarch.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const TRANSMITTANCE_SIZE: [number, number] = [256, 64];
const MULTI_SCATTERING_SIZE: [number, number] = [32, 32];
const SKY_VIEW_SIZE: [number, number] = [256, 160];
const TRANSMITTANCE_STEPS = 40;
const MULTI_SCATTERING_DIRECTIONS = 64;
const MULTI_SCATTERING_STEPS = 20;
const SKY_VIEW_STEPS = 32;
const WORKGROUP = 8;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const MAX_TRANSFER = 0.95;

function storage(name: string, [width, height]: [number, number]): THREE.StorageTexture {
  const texture = new THREE.StorageTexture(width, height);
  texture.name = name;
  texture.type = THREE.HalfFloatType;
  texture.format = THREE.RGBAFormat;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  return texture;
}

function eachTexel(size: [number, number], body: (id: N) => void): N {
  return Fn(() => {
    If(globalId.x.lessThan(size[0]).and(globalId.y.lessThan(size[1])), () => body(globalId));
  })().computeKernel([WORKGROUP, WORKGROUP, 1]);
}

function sunInPlane(cosZenith: N): N {
  return vec3(sqrt(max(float(1).sub(cosZenith.mul(cosZenith)), 0)), cosZenith, 0);
}

function fibonacciDirection(index: N): N {
  const y = float(1).sub(float(index).add(0.5).mul(2 / MULTI_SCATTERING_DIRECTIONS));
  const ring = sqrt(max(float(1).sub(y.mul(y)), 0));
  const angle = float(index).mul(GOLDEN_ANGLE);
  return vec3(ring.mul(angle.cos()), y, ring.mul(angle.sin()));
}

export class AtmosphereLuts {
  readonly transmittance = storage('skyTransmittance', TRANSMITTANCE_SIZE);
  readonly multiScattering = storage('skyMultiScattering', MULTI_SCATTERING_SIZE);
  readonly skyView = storage('skyView', SKY_VIEW_SIZE);
  readonly viewRadius = uniform(6360.001);
  readonly sunCosZenith = uniform(1);
  readonly transmittanceSource: LutSource;
  private readonly kernels: { transmittance: N; multiScattering: N; skyView: N };

  constructor(private readonly renderer: THREE.WebGPURenderer, readonly atmosphere: AtmosphereUniforms) {
    this.transmittanceSource = { texture: this.transmittance, size: TRANSMITTANCE_SIZE, atmosphere };
    this.kernels = {
      transmittance: this.transmittanceKernel().setName('Sky Transmittance LUT'),
      multiScattering: this.multiScatteringKernel().setName('Sky Multi-scattering LUT'),
      skyView: this.skyViewKernel().setName('Sky View LUT'),
    };
  }

  get multiScatteringSource(): { texture: THREE.Texture; size: [number, number] } {
    return { texture: this.multiScattering, size: MULTI_SCATTERING_SIZE };
  }

  get skyViewSize(): [number, number] {
    return SKY_VIEW_SIZE;
  }

  computeAtmosphere(): void {
    this.dispatch(this.kernels.transmittance, TRANSMITTANCE_SIZE);
    this.dispatch(this.kernels.multiScattering, MULTI_SCATTERING_SIZE);
  }

  computeSkyView(viewRadiusKm: number, sunCosZenith: number): void {
    this.viewRadius.value = viewRadiusKm;
    this.sunCosZenith.value = sunCosZenith;
    this.dispatch(this.kernels.skyView, SKY_VIEW_SIZE);
  }

  private dispatch(kernel: N, [width, height]: [number, number]): void {
    this.renderer.compute(kernel, [Math.ceil(width / WORKGROUP), Math.ceil(height / WORKGROUP), 1]);
  }

  private transmittanceKernel(): N {
    const atmosphere = this.atmosphere;
    return eachTexel(TRANSMITTANCE_SIZE, (id) => {
      const unit = vec2(id.xy).div(vec2(TRANSMITTANCE_SIZE[0] - 1, TRANSMITTANCE_SIZE[1] - 1));
      const { radius, cosZenith } = transmittanceLutParameters(atmosphere, unit);
      const origin = vec3(0, radius, 0);
      const direction = sunInPlane(cosZenith);
      const segment = sphereDistances(origin, direction, atmosphere.topRadius).far.div(TRANSMITTANCE_STEPS);
      const depth = vec3(0).toVar();
      Loop(TRANSMITTANCE_STEPS, ({ i }: { i: N }) => {
        const position = origin.add(direction.mul(float(i).add(0.5).mul(segment)));
        depth.addAssign(sampleMedium(atmosphere, length(position)).extinction.mul(segment));
      });
      textureStore(this.transmittance, uvec2(id.x, id.y), vec4(exp(depth.negate()), 1));
    });
  }

  private multiScatteringKernel(): N {
    const atmosphere = this.atmosphere;
    return eachTexel(MULTI_SCATTERING_SIZE, (id) => {
      const unit = vec2(id.xy).div(vec2(MULTI_SCATTERING_SIZE[0] - 1, MULTI_SCATTERING_SIZE[1] - 1));
      const sunDirection = sunInPlane(unit.x.mul(2).sub(1));
      const origin = vec3(0, atmosphere.groundRadius.add(unit.y.mul(atmosphere.topRadius.sub(atmosphere.groundRadius))), 0);
      const luminance = vec3(0).toVar();
      const transfer = vec3(0).toVar();
      Loop(MULTI_SCATTERING_DIRECTIONS, ({ i }: { i: N }) => {
        const ray: MarchRay = { origin, direction: fibonacciDirection(i), sunDirection, steps: MULTI_SCATTERING_STEPS, phase: 'isotropic', multiScattering: null, multiScatteringSize: MULTI_SCATTERING_SIZE };
        const march = marchScattering(this.transmittanceSource, ray);
        luminance.addAssign(march.luminance.add(groundBounce(this.transmittanceSource, ray, march)));
        transfer.addAssign(march.transfer);
      });
      const secondOrder = luminance.div(MULTI_SCATTERING_DIRECTIONS);
      const series = float(1).div(float(1).sub(transfer.div(MULTI_SCATTERING_DIRECTIONS).min(MAX_TRANSFER)));
      textureStore(this.multiScattering, uvec2(id.x, id.y), vec4(secondOrder.mul(series).mul(atmosphere.multiScattering), 1));
    });
  }

  private skyViewKernel(): N {
    return eachTexel(SKY_VIEW_SIZE, (id) => {
      const unit = vec2(id.xy).div(vec2(SKY_VIEW_SIZE[0] - 1, SKY_VIEW_SIZE[1] - 1));
      const ray: MarchRay = {
        origin: vec3(0, this.viewRadius, 0),
        direction: skyViewDirection(this.atmosphere, this.viewRadius, unit),
        sunDirection: sunInPlane(this.sunCosZenith),
        steps: SKY_VIEW_STEPS,
        phase: 'directional',
        multiScattering: this.multiScattering,
        multiScatteringSize: MULTI_SCATTERING_SIZE,
      };
      const march = marchScattering(this.transmittanceSource, ray);
      const luminance = march.luminance.add(groundBounce(this.transmittanceSource, ray, march));
      textureStore(this.skyView, uvec2(id.x, id.y), vec4(luminance, 1));
    });
  }
}
