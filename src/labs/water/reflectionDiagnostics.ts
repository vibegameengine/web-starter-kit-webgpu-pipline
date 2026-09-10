import * as THREE from 'three/webgpu';
import { Fn, float, instanceIndex, sampler, storage, texture, textureCubeUV, uint, uv, vec4 } from 'three/tsl';
import { sampleWaterPmrem } from '../../entities/water/pmremSample.ts';
import { visibleWaterNormal } from '../../entities/water/visibleNormal.ts';

export async function checkReflectionMath(renderer: THREE.WebGPURenderer, environment: THREE.Texture) {
  const count = 1024;
  const input = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) {
    const y = 1 - 2 * (i + 0.5) / count, angle = i * 2.399963229728653;
    input.set([Math.sqrt(1 - y * y) * Math.cos(angle), y, Math.sqrt(1 - y * y) * Math.sin(angle), (i % 32) / 31], i * 8);
    const view = new THREE.Vector3(Math.cos(angle * 0.73), 0.0001 + (i % 37) / 37, Math.sin(angle * 0.73)).normalize();
    view.toArray(input, i * 8 + 4);
  }
  const inputAttribute = new THREE.StorageBufferAttribute(input, 4);
  const outputAttribute = new THREE.StorageBufferAttribute(new Float32Array(count * 8), 4);
  const source = storage(inputAttribute, 'vec4', count * 2).toReadOnly();
  const result = storage(outputAttribute, 'vec4', count * 2);
  const generator = new THREE.PMREMGenerator(renderer);
  const pmrem = generator.fromEquirectangular(environment);
  const compute = Fn(() => {
    const value = source.element(instanceIndex.mul(2));
    const shading = value.xyz.mul(vec4(1, 0.8, 1, 0).xyz).normalize();
    const upward = vec4(shading.x, shading.y.abs(), shading.z, 0).xyz;
    result.element(instanceIndex.mul(2)).assign(vec4(sampleWaterPmrem({ atlas: texture(pmrem.texture), atlasSampler: sampler(pmrem.texture), direction: value.xyz, roughness: value.w }), 1));
    result.element(instanceIndex.mul(2).add(1)).assign(vec4(visibleWaterNormal({ shading: upward, geometric: vec4(0, 1, 0, 0).xyz, view: source.element(instanceIndex.mul(2).add(1)).xyz }), 1));
  })().compute(count);
  const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, toneMapped: false });
  const value = source.element(uint(uv().x.mul(count)).min(count - 1).mul(2));
  material.fragmentNode = vec4(textureCubeUV(texture(pmrem.texture), value.xyz, value.w, float(1 / pmrem.width), float(1 / pmrem.height), float(Math.log2(pmrem.height) - 2)), 1);
  const target = new THREE.RenderTarget(count, 1, { type: THREE.FloatType, depthBuffer: false });
  const previousTarget = renderer.getRenderTarget(), previousMrt = renderer.getMRT();
  try {
    renderer.compute(compute);
    const actual = new Float32Array(await renderer.getArrayBufferAsync(outputAttribute));
    renderer.setRenderTarget(target);
    renderer.setMRT(null);
    new THREE.QuadMesh(material).render(renderer);
    const reference = await renderer.readRenderTargetPixelsAsync(target, 0, 0, count, 1);
    let maximumEnvironmentError = 0, invalidNormals = 0, changedValidNormals = 0;
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < 3; c++) maximumEnvironmentError = Math.max(maximumEnvironmentError, Math.abs(actual[i * 8 + c] - reference[i * 4 + c]));
      const normal = new THREE.Vector3().fromArray(actual, i * 8 + 4), view = new THREE.Vector3().fromArray(input, i * 8 + 4);
      const shading = new THREE.Vector3(input[i * 8], Math.abs(input[i * 8 + 1]) * 0.8, input[i * 8 + 2]).normalize();
      const threshold = Math.min(0.01, view.y * 0.9);
      if (!Number.isFinite(normal.y) || view.clone().negate().reflect(normal).y < threshold - 0.00001 || normal.dot(view) <= 0) invalidNormals++;
      if (shading.dot(view) > 0 && view.clone().negate().reflect(shading).y >= threshold && normal.distanceTo(shading) > 0.00001) changedValidNormals++;
    }
    return { samples: count, maximumEnvironmentError, invalidNormals, changedValidNormals, passed: maximumEnvironmentError < 0.002 && invalidNormals === 0 && changedValidNormals === 0 };
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.setMRT(previousMrt);
    for (const attribute of [inputAttribute, outputAttribute]) (renderer.backend as unknown as { destroyAttribute(value: THREE.StorageBufferAttribute): void }).destroyAttribute(attribute);
    material.dispose(); target.dispose(); pmrem.dispose(); generator.dispose();
  }
}
