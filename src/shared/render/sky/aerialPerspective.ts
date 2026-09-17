import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, exp, float, globalId, length, max, mix, normalize, perspectiveDepthToViewZ, step,
  screenUV, select, texture3D, textureStore, uniform, uvec3, vec2, vec3, vec4,
} from 'three/tsl';
import { miePhase, rayleighPhase, sampleMedium, sphereDistances } from './atmosphereMedium.ts';
import { readTransmittance } from './lutMapping.ts';
import { readMultiScattering } from './scatteringMarch.ts';
import type { SkyAtmosphere } from './skyAtmosphere.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const COLUMNS = 32;
const ROWS = 32;
const SLICES = 16;
const DEPTH_KM = 32;
const WORKGROUP = 8;
const METRES_PER_KM = 1000;
const FAR_DEPTH = 0.99999;
const SURFACE_LIFT_KM = 0.0005;

/* @important Aerial perspective as a camera-aligned volume, the froxel scheme of Hillaire 2020 section
   5.4: 32x32 columns, 16 linear slices to 32 km, each texel the light scattered into the view ray and the
   transmittance from the camera to that slice. It is recomputed every frame, since at 16k texels it is
   cheaper than deciding whether the camera or the sun moved, and applied in the composite to every
   opaque pixel before the local fog. `distanceScale` stretches the scene's metres into atmosphere
   distance: at 1 a 20 m diorama shows no haze at all, which is physically right and artistically
   useless, so a small scene can ask for kilometres of air on purpose. The sky pixels are left alone;
   the sky view already carries the whole ray. Distance is the linear view depth from this class's own
   near and far, as the volumetric fog does it: reconstructing a view position in the screen pass, with
   the shared projection node or with a matrix uniform, turned the composite into NaN and a black sky -
   a pass-through apply rendered correctly, and so did the full apply returned without its sky mask,
   while `select(cond, beauty, beauty)` alone turned the sky black. A TSL select over the composite's
   beauty node in this screen pass is the fault, so the sky is masked with mix(step) instead. */
export class AerialPerspective {
  readonly volume: THREE.Storage3DTexture;
  readonly distanceScale = uniform(1);
  private readonly inverseProjection = uniform(new THREE.Matrix4());
  private readonly cameraWorld = uniform(new THREE.Matrix4());
  private readonly illuminance = uniform(1);
  private readonly near = uniform(0.1);
  private readonly far = uniform(1000);
  private readonly kernel: N;

  constructor(private readonly renderer: THREE.WebGPURenderer, private readonly sky: SkyAtmosphere) {
    this.volume = new THREE.Storage3DTexture(COLUMNS, ROWS, SLICES);
    this.volume.type = THREE.HalfFloatType;
    this.volume.format = THREE.RGBAFormat;
    this.volume.minFilter = THREE.LinearFilter;
    this.volume.magFilter = THREE.LinearFilter;
    this.volume.wrapS = this.volume.wrapT = this.volume.wrapR = THREE.ClampToEdgeWrapping;
    this.volume.generateMipmaps = false;
    this.kernel = this.buildKernel();
  }

  update(camera: THREE.PerspectiveCamera, distanceScale: number): void {
    this.distanceScale.value = distanceScale;
    this.inverseProjection.value.copy(camera.projectionMatrixInverse);
    this.cameraWorld.value.copy(camera.matrixWorld);
    this.illuminance.value = this.sky.sunIlluminance.value;
    this.near.value = camera.near;
    this.far.value = camera.far;
    this.renderer.compute(this.kernel, [Math.ceil(COLUMNS / WORKGROUP), Math.ceil(ROWS / WORKGROUP), 1]);
  }

  apply(beauty: N, depth: N): N {
    const rawDepth = float(depth);
    const viewDepth = perspectiveDepthToViewZ(rawDepth, this.near, this.far).negate().max(0);
    const distance = viewDepth.div(METRES_PER_KM).mul(this.distanceScale);
    const sliceDepth = DEPTH_KM / SLICES;
    const w = distance.div(DEPTH_KM).sub(0.5 / SLICES).clamp(0.5 / SLICES, 1 - 0.5 / SLICES);
    const nearFade = distance.div(sliceDepth).clamp(0, 1);
    const air = texture3D(this.volume, vec3(screenUV, w)).level(float(0));
    const transmittance = float(1).sub(nearFade.mul(float(1).sub(air.a)));
    const inscatter = air.rgb.mul(nearFade).mul(this.illuminance);
    const hazed = vec4(vec3(beauty).mul(transmittance).add(inscatter), vec4(beauty).a);
    const geometry = step(rawDepth, float(FAR_DEPTH));
    return mix(vec4(beauty), hazed, geometry);
  }

  private viewDirection(column: N): N {
    const uv = vec2(column).add(0.5).div(vec2(COLUMNS, ROWS));
    const clip = vec4(uv.x.mul(2).sub(1), float(1).sub(uv.y.mul(2)), 1, 1);
    const view = this.inverseProjection.mul(clip);
    return normalize(this.cameraWorld.mul(vec4(view.xyz.div(view.w), 0)).xyz);
  }

  private inScattering(sample: N, direction: N): { source: N; extinction: N } {
    const sky = this.sky;
    const source = sky.luts.transmittanceSource;
    const radius = max(length(sample), source.atmosphere.groundRadius.add(SURFACE_LIFT_KM));
    const position = normalize(sample).mul(radius);
    const cosSun = sky.sunDirection.dot(position.div(radius));
    const medium = sampleMedium(source.atmosphere, radius);
    const cosTheta = direction.dot(sky.sunDirection);
    const phased = medium.rayleighScattering.mul(rayleighPhase(cosTheta)).add(medium.mieScattering.mul(miePhase(cosTheta, source.atmosphere.mieAnisotropy)));
    const planet = sphereDistances(position, vec3(sky.sunDirection), source.atmosphere.groundRadius);
    const lit = select(planet.hit.and(planet.far.greaterThan(0)), float(0), float(1));
    const direct = readTransmittance(source, radius, cosSun).mul(lit).mul(phased);
    const multiple = readMultiScattering(source, sky.luts.multiScatteringSource, radius, cosSun).mul(medium.scattering);
    return { source: direct.add(multiple), extinction: max(medium.extinction, vec3(1e-9)) };
  }

  private buildKernel(): N {
    return Fn(() => {
      If(globalId.x.lessThan(COLUMNS).and(globalId.y.lessThan(ROWS)), () => {
        const direction = this.viewDirection(globalId.xy);
        const origin = vec3(0, this.sky.luts.viewRadius, 0);
        const segment = float(DEPTH_KM / SLICES);
        const luminance = vec3(0).toVar();
        const throughput = vec3(1).toVar();
        Loop(SLICES, ({ i }: { i: N }) => {
          const position = origin.add(direction.mul(float(i).add(0.5).mul(segment)));
          const { source, extinction } = this.inScattering(position, direction);
          const step = exp(extinction.mul(segment).negate());
          luminance.addAssign(throughput.mul(source.sub(source.mul(step)).div(extinction)));
          throughput.mulAssign(step);
          const mean = throughput.x.add(throughput.y).add(throughput.z).div(3);
          textureStore(this.volume, uvec3(globalId.x, globalId.y, i), vec4(luminance, mean));
        });
      });
    })().computeKernel([WORKGROUP, WORKGROUP, 1]).setName('Aerial perspective');
  }
}
