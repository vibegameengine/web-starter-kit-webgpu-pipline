import * as THREE from 'three/webgpu';
import { Fn, float, mat4, select, storage, uniform, vec3, vec4 } from 'three/tsl';
import { SurfaceRaycaster } from '../../entities/water/surfaceRaycaster.ts';
import { waterSolarScatter } from '../../entities/water/volumeLight.ts';
import type { WaterRayScene } from '../../entities/water/rayScene.ts';
import { SEAWATER_INDEX_550_NM as n } from '../../entities/water/physicsReference.ts';

export async function checkVolumeLight(renderer: THREE.WebGPURenderer) {
  const field = new THREE.DataTexture(new Float32Array(32 * 32 * 4), 32, 32, THREE.RGBAFormat, THREE.FloatType);
  field.minFilter = field.magFilter = THREE.LinearFilter;
  field.needsUpdate = true;
  const surface = new SurfaceRaycaster(field, 32, 8, 0, float(1));
  const absorption = uniform(new THREE.Vector3(0.32, 0.1, 0.055));
  const scattering = uniform(new THREE.Vector3(0.035, 0.035, 0.035));
  const sun = uniform(new THREE.Vector3(0, 1, 0));
  const irradiance = uniform(new THREE.Vector3(3, 3, 3));
  const shadow = uniform(0);
  const scene = { trace: ({ origin, direction }: { origin: THREE.Node; direction: THREE.Node }) => {
    const ray = vec3(direction), point = vec3(origin);
    const down = ray.y.lessThan(0);
    const hit = select(down, float(1), shadow);
    const distance = select(down, point.y.add(2).div(ray.y.negate()), float(0.001));
    return mat4(vec4(point.add(ray.mul(distance)), distance), vec4(0, 1, 0, hit), vec4(0), vec4(0));
  } } as unknown as WaterRayScene;
  const attribute = new THREE.StorageBufferAttribute(new Float32Array(4), 4);
  const output = storage(attribute, 'vec4', 1);
  const compute = Fn(() => {
    output.element(0).assign(vec4(waterSolarScatter({ scene, surface, half: 8, absorption, scattering,
      sunDirection: sun, sunIrradiance: irradiance }, vec3(0, 0.0005, 0), vec3(0, -1, 0), vec3(0, 1, 0)), 1));
  })().compute(1);
  const read = async () => { renderer.compute(compute); return Array.from(new Float32Array(await renderer.getArrayBufferAsync(attribute))).slice(0, 3); };
  try {
    surface.update(renderer);
    const flat = await read();
    const phase = (1 - 0.924 ** 2) / (4 * Math.PI * (1 + 0.924) ** 3);
    const transmission = 1 - ((1 - n) / (1 + n)) ** 2;
    const expected = [0.32, 0.1, 0.055].map(a => {
      const c = a + 0.035;
      return 3 * 0.035 * phase * transmission / n ** 2 * Math.exp(-c * 0.004) * (1 - Math.exp(-2 * c * 1.9965)) / (2 * c);
    });
    shadow.value = 1;
    const occluded = await read();
    shadow.value = 0;
    sun.value.set(0, -1, 0);
    const night = await read();
    sun.value.set(0, 1, 0);
    scattering.value.setScalar(0);
    const clear = await read();
    const maximumRelativeError = Math.max(...flat.map((value, i) => Math.abs(value / expected[i] - 1)));
    return { flat, expected, maximumRelativeError, occluded, night, clear,
      passed: maximumRelativeError < 0.01 && [...occluded, ...night, ...clear].every(value => value === 0) };
  } finally {
    compute.dispose(); surface.dispose(renderer); field.dispose();
    (renderer.backend as unknown as { destroyAttribute(value: THREE.StorageBufferAttribute): void }).destroyAttribute(attribute);
  }
}
