import * as THREE from 'three/webgpu';
import { Fn, If, float, instanceIndex, ivec2, sampler, storage, texture, uint, vec4 } from 'three/tsl';
import { traceWaterSurface, waterVertex } from '../../entities/water/surfaceTrace.ts';
import { SurfaceRaycaster } from '../../entities/water/surfaceRaycaster.ts';

export async function checkSurfaceRays(renderer: THREE.WebGPURenderer, hierarchical = false) {
  const size = 32, cells = 32, half = 3;
  const data = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const wx = ((x + 0.5) / size * 2 - 1) * half;
    const wz = ((y + 0.5) / size * 2 - 1) * half;
    data[(y * size + x) * 4] = Math.sin(wx * 1.7) * Math.cos(wz * 2.1) * 0.45 + Math.sin(wz * 0.8) * 0.2;
  }
  const field = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
  field.minFilter = field.magFilter = THREE.LinearFilter;
  field.needsUpdate = true;
  const height = (x: number, z: number) => {
    const px = Math.max(0, Math.min(size - 1, (x / half * 0.5 + 0.5) * size - 0.5));
    const pz = Math.max(0, Math.min(size - 1, (z / half * 0.5 + 0.5) * size - 0.5));
    const ix = Math.floor(px), iz = Math.floor(pz), fx = px - ix, fz = pz - iz;
    const at = (dx: number, dz: number) => data[(Math.min(size - 1, iz + dz) * size + Math.min(size - 1, ix + dx)) * 4];
    return (at(0, 0) * (1 - fx) + at(1, 0) * fx) * (1 - fz) + (at(0, 1) * (1 - fx) + at(1, 1) * fx) * fz + 0.0005;
  };
  const geometry = new THREE.PlaneGeometry(half * 2, half * 2, cells, cells);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) positions.setY(i, height(positions.getX(i), positions.getZ(i)));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.updateMatrixWorld();
  const rays: Array<{ origin: THREE.Vector3; direction: THREE.Vector3 }> = [];
  let state = 177;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  for (let i = 0; i < 768; i++) {
    const origin = new THREE.Vector3(random() * 10 - 5, random() * 4 - 2, random() * 10 - 5);
    const aim = new THREE.Vector3(random() * 8 - 4, random() * 1.6 - 0.8, random() * 8 - 4);
    rays.push({ origin, direction: aim.sub(origin).normalize() });
  }
  for (const x of [-3, -2.75, 0, 2.75, 3, 3.01]) for (const z of [-3, 0, 3]) for (const y of [-1, 1]) {
    rays.push({ origin: new THREE.Vector3(x, y, z), direction: new THREE.Vector3(0, -Math.sign(y), 0) });
    rays.push({ origin: new THREE.Vector3(-4, y * 0.1, z), direction: new THREE.Vector3(1, 0, 0) });
  }
  const packed = new Float32Array(rays.length * 8);
  rays.forEach(({ origin, direction }, i) => {
    origin.toArray(packed, i * 8); direction.toArray(packed, i * 8 + 4);
    origin.fromArray(packed, i * 8); direction.fromArray(packed, i * 8 + 4);
  });
  const sourceAttribute = new THREE.StorageBufferAttribute(packed, 4);
  const resultAttribute = new THREE.StorageBufferAttribute(new Float32Array(rays.length * 4), 4);
  const vertexAttribute = new THREE.StorageBufferAttribute(new Float32Array(positions.count * 4), 4);
  const input = storage(sourceAttribute, 'vec4', rays.length * 2).toReadOnly();
  const output = storage(resultAttribute, 'vec4', rays.length);
  const vertices = storage(vertexAttribute, 'vec4', positions.count);
  const tree = hierarchical ? new SurfaceRaycaster(field, cells, half, 0, float(1)) : null;
  const compute = Fn(() => {
    If(instanceIndex.lessThan(uint(rays.length)), () => {
    const hit = tree ? tree.trace(input.element(instanceIndex.mul(2)).xyz, input.element(instanceIndex.mul(2).add(1)).xyz, float(30)) : traceWaterSurface({ origin: input.element(instanceIndex.mul(2)).xyz,
      direction: input.element(instanceIndex.mul(2).add(1)).xyz, maxDistance: float(30),
      field: texture(field), fieldSampler: sampler(field), cells: uint(cells), halfSize: float(half), level: float(0), strength: float(1) });
    output.element(instanceIndex).assign(vec4(hit));
    });
    If(instanceIndex.lessThan(uint(positions.count)), () => {
      const vertex = waterVertex({ grid: ivec2(instanceIndex.mod(cells + 1), instanceIndex.div(cells + 1)),
        field: texture(field), fieldSampler: sampler(field), cells: uint(cells), halfSize: float(half), level: float(0), strength: float(1) });
      vertices.element(instanceIndex).assign(vec4(vertex, 1));
    });
  })().compute(Math.max(rays.length, positions.count));
  try {
    tree?.update(renderer);
    renderer.compute(compute);
    const actual = new Float32Array(await renderer.getArrayBufferAsync(resultAttribute));
    const gpuVertices = new Float32Array(await renderer.getArrayBufferAsync(vertexAttribute));
    let maximumFilteredHeightDifference = 0;
    for (let i = 0; i < positions.count; i++) {
      maximumFilteredHeightDifference = Math.max(maximumFilteredHeightDifference, Math.abs(positions.getY(i) - gpuVertices[i * 4 + 1]));
      positions.setXYZ(i, gpuVertices[i * 4], gpuVertices[i * 4 + 1], gpuVertices[i * 4 + 2]);
    }
    let hits = 0, maximumDistanceError = 0;
    const failures = [];
    const caster = new THREE.Raycaster();
    for (let i = 0; i < rays.length; i++) {
      caster.set(rays[i].origin, rays[i].direction);
      const hit = caster.intersectObject(mesh, false)[0];
      const expected = hit ? hit.distance / rays[i].direction.length() : 0;
      const distance = actual[i * 4 + 3];
      const error = Math.abs(distance - expected);
      if (expected > 0) { hits++; maximumDistanceError = Math.max(maximumDistanceError, error); }
      if ((expected > 0) !== (distance > 0) || error > 0.001) failures.push({ ray: i, expected, distance, error });
    }
    return { hierarchical, rays: rays.length, hits, maximumDistanceError, maximumFilteredHeightDifference, failures, passed: failures.length === 0 };
  } finally {
    for (const attribute of [sourceAttribute, resultAttribute, vertexAttribute]) (renderer.backend as unknown as { destroyAttribute(value: THREE.StorageBufferAttribute): void }).destroyAttribute(attribute);
    geometry.dispose(); mesh.material.dispose(); field.dispose();
    tree?.dispose(renderer);
  }
}
