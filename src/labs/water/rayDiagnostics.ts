import * as THREE from 'three/webgpu';
import { Fn, instanceIndex, mat4, storage, uint, vec4 } from 'three/tsl';
import type { WaterRayScene } from '../../entities/water/rayScene.ts';

export async function checkGeometryRays(renderer: THREE.WebGPURenderer, scene: THREE.Scene, rayScene: WaterRayScene) {
  const objects: THREE.Mesh[] = [];
  scene.traverseVisible(object => { if (object instanceof THREE.Mesh && object.layers.isEnabled(0)) objects.push(object); });
  rayScene.update();
  const origins: THREE.Vector3[] = [];
  const directions: THREE.Vector3[] = [];
  const center = new THREE.Vector3();
  for (const mesh of objects) {
    new THREE.Box3().setFromObject(mesh).getCenter(center);
    for (let i = 0; i < 64; i++) {
      const angle = i * 2.399963229728653;
      const vertical = (i + 0.5) / 64 * 2 - 1;
      const radius = Math.sqrt(1 - vertical * vertical);
      const offset = new THREE.Vector3(radius * Math.cos(angle), vertical, radius * Math.sin(angle));
      const origin = center.clone().addScaledVector(offset, 4.5);
      const aim = center.clone().add(new THREE.Vector3(Math.sin(i * 1.37), Math.cos(i * 2.17), Math.sin(i * 3.71)).multiplyScalar(0.55));
      origins.push(origin); directions.push(aim.sub(origin).normalize());
    }
  }
  for (let i = 0; i < 32; i++) {
    origins.push(new THREE.Vector3(i - 16, 8, 3));
    directions.push(new THREE.Vector3(Math.sin(i), 1, Math.cos(i)).normalize());
  }
  const count = origins.length;
  const inputs = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) {
    origins[i].toArray(inputs, i * 8);
    directions[i].toArray(inputs, i * 8 + 4);
    origins[i].fromArray(inputs, i * 8);
    directions[i].fromArray(inputs, i * 8 + 4);
  }
  const inputAttribute = new THREE.StorageBufferAttribute(inputs, 4);
  const resultAttribute = new THREE.StorageBufferAttribute(new Float32Array(count * 4), 4);
  const input = storage(inputAttribute, 'vec4', count * 2).toReadOnly();
  const results = storage(resultAttribute, 'vec4', count);
  const compute = Fn(() => {
    const hit = rayScene.trace({ origin: input.element(instanceIndex.mul(2)).xyz, direction: input.element(instanceIndex.mul(2).add(1)).xyz }) as ReturnType<typeof mat4>;
    results.element(instanceIndex).assign(vec4((hit.element(uint(0)) as ReturnType<typeof vec4>).w, (hit.element(uint(1)) as ReturnType<typeof vec4>).w, (hit.element(uint(2)) as ReturnType<typeof vec4>).z, 0));
  })().compute(count);
  const expected: Array<{ distance: number; material: number }> = [];
  const materials = new Map<THREE.Material, THREE.Side>();
  objects.forEach(mesh => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => materials.set(material, material.side)));
  try {
    materials.forEach((_, material) => { material.side = THREE.DoubleSide; });
    const caster = new THREE.Raycaster();
    for (let i = 0; i < count; i++) {
      caster.set(origins[i], directions[i]);
      const hit = caster.intersectObjects(objects, false)[0];
      const mesh = hit?.object as THREE.Mesh | undefined;
      const material = mesh ? Array.isArray(mesh.material) ? mesh.material[hit.face!.materialIndex] : mesh.material : null;
      expected.push({ distance: hit ? hit.distance / directions[i].length() : 0, material: material ? rayScene.materialIds.get(material.uuid)! : -1 });
    }
  } finally {
    materials.forEach((side, material) => { material.side = side; });
  }
  try {
    renderer.compute(compute);
    const actual = new Float32Array(await renderer.getArrayBufferAsync(resultAttribute));
    let maximumDistanceError = 0;
    let hits = 0;
    const failures = [];
    for (let i = 0; i < count; i++) {
      const gpuHit = actual[i * 4 + 1] > 0.5;
      const cpuHit = expected[i].material >= 0;
      const error = Math.abs(actual[i * 4] - expected[i].distance);
      if (cpuHit) { hits++; maximumDistanceError = Math.max(maximumDistanceError, error); }
      if (gpuHit !== cpuHit || (cpuHit && (error > 0.001 || Math.round(actual[i * 4 + 2]) !== expected[i].material))) failures.push({ ray: i, gpu: Array.from(actual.slice(i * 4, i * 4 + 3)), expected: expected[i], error });
    }
    return { rays: count, hits, misses: count - hits, maximumDistanceError, failures, passed: failures.length === 0 };
  } finally {
    for (const attribute of [inputAttribute, resultAttribute]) (renderer.backend as unknown as { destroyAttribute(value: THREE.StorageBufferAttribute): void }).destroyAttribute(attribute);
  }
}

