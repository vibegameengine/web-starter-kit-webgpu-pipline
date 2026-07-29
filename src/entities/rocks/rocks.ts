import * as THREE from 'three/webgpu';

import { Layer, Mobility, applyMobility } from '../../shared/world/index.ts';

export interface RocksOptions {
  extent?: number;
  count?: number;
  seed?: number;
  map?: THREE.Texture | null;
  heightAt: (x: number, z: number) => number;
}

export interface Rocks {
  object: THREE.Group;
  mesh: THREE.InstancedMesh;
  baseTriangles: number;
  instanceCount: number;
  materials: THREE.Material[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Instanced boulders — opaque, solid, closed.
 *
 * Deliberately a second instanced layer with none of foliage's complications. If the
 * ray tracer misses these too, the fault is instancing and not alpha cutout; if it
 * misses only the foliage, the fault is the cutout. One scene, two controls.
 */
export function createRocks(options: RocksOptions): Rocks {
  const { extent = 160, count = 150, seed = 4242, map = null, heightAt } = options;

  const random = mulberry32(seed);
  const geometry = new THREE.IcosahedronGeometry(1, 1);

  // Push each vertex out by a fixed per-direction amount so the silhouette reads as
  // rock rather than as a geodesic sphere. Done once on the base geometry: every
  // instance shares it, which is the whole point of instancing.
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const wobble = 0.72 + 0.5 * Math.abs(Math.sin(v.x * 3.1 + v.y * 2.3 + v.z * 1.7));
    v.multiplyScalar(wobble);
    position.setXYZ(i, v.x, v.y * 0.72, v.z);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardNodeMaterial({
    roughness: 0.92,
    metalness: 0,
  });
  // `color` is a *multiplier* on `map`, not the surface colour, and it multiplies in
  // the linear working space. `new THREE.Color(0x8d8a84)` reads as "light grey,
  // 141/138/132" only in sRGB; as a linear factor it is 0.26, so it threw away 74 % of
  // the map. Stacked on a rock photograph that already averages 0.076 linear, the
  // compound albedo came out at 0.020 — darker than coal — and the boulders rendered as
  // holes in the ground while the terrain, whose tint is written straight into the
  // linear space by `Color.setHSL()` and is therefore ~2.4× brighter as a factor, did
  // not. When a map supplies the reflectance the tint has to be white; the map is put
  // into a physical albedo range by `normaliseAlbedoRange` in `widgets/world/largeScene`.
  if (map) {
    material.map = map;
    material.color.setRGB(1, 1, 1);
  } else {
    // No map: now `color` really is the albedo, and 0x8d8a84 (linear 0.26) is a
    // reasonable dry-granite reflectance on its own.
    material.color.set(0x8d8a84);
  }
  material.name = 'rock';

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = 'rocks';

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const translation = new THREE.Vector3();
  const scale = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    const x = (random() * 2 - 1) * extent;
    const z = (random() * 2 - 1) * extent;
    const s = 0.6 + random() * 2.6;
    translation.set(x, heightAt(x, z) - s * 0.22, z);
    euler.set(random() * 0.5 - 0.25, random() * Math.PI * 2, random() * 0.5 - 0.25);
    quaternion.setFromEuler(euler);
    scale.set(s, s * (0.6 + random() * 0.6), s);
    matrix.compose(translation, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;

  const group = new THREE.Group();
  group.name = 'rocks';
  group.add(mesh);
  applyMobility(group, Mobility.Static);
  group.traverse((object) => object.layers.enable(Layer.GiStatic));

  return {
    object: group,
    mesh,
    baseTriangles: (geometry.index ? geometry.index.count : position.count) / 3,
    instanceCount: count,
    materials: [material],
  };
}
