import * as THREE from 'three/webgpu';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

import { Layer, Mobility, applyMobility } from '../../shared/world/index.ts';
import { createBladeTexture } from './bladeTexture.ts';

export interface FoliageOptions {
  /** Scatter radius in metres from the world origin. */
  extent?: number;
  grassCount?: number;
  fernCount?: number;
  seed?: number;
  /** Ground height lookup, injected — foliage never imports the terrain slice. */
  heightAt: (x: number, z: number) => number;
}

export interface FoliageLayer {
  mesh: THREE.InstancedMesh;
  /** Triangles in the base geometry, before instancing. */
  baseTriangles: number;
  instanceCount: number;
}

export interface Foliage {
  object: THREE.Group;
  layers: FoliageLayer[];
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

/** Crossed cards: the standard cheap foliage cluster, and the standard tracer problem. */
function crossedCards(width: number, height: number, cards: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < cards; i++) {
    const card = new THREE.PlaneGeometry(width, height, 1, 1);
    card.translate(0, height * 0.5, 0);
    card.rotateY((i / cards) * Math.PI);
    parts.push(card);
  }
  const merged = BufferGeometryUtils.mergeGeometries(parts);
  if (!merged) throw new Error('crossedCards: merge failed');
  merged.computeVertexNormals();
  return merged;
}

/**
 * GPU-instanced ground cover.
 *
 * Two `InstancedMesh` layers, thousands of instances each. This is the shape of
 * geometry every forest is mostly made of, and it is also the shape the BVH builder in
 * `shared/gi/surfel/sceneBvh.ts` gets wrong: it treats an `InstancedMesh` as a plain
 * `Mesh` and bakes exactly one copy using the object's own world matrix, because
 * `instanceMatrix` is read nowhere. So every instance past the first is invisible to
 * the ray tracer while being fully visible to the raster pass.
 *
 * That divergence is not incidental to this scene, it is the reason the scene exists:
 * `__scale().counts` reports raster triangles and BVH triangles separately so the gap
 * is a number rather than an impression.
 */
export function createFoliage(options: FoliageOptions): Foliage {
  const {
    extent = 170,
    grassCount = 4000,
    fernCount = 1200,
    seed = 90210,
    heightAt,
  } = options;

  const random = mulberry32(seed);
  const group = new THREE.Group();
  group.name = 'foliage';
  const layers: FoliageLayer[] = [];
  const materials: THREE.Material[] = [];

  const build = (
    name: string,
    geometry: THREE.BufferGeometry,
    map: THREE.Texture,
    count: number,
    scaleRange: [number, number],
  ): void => {
    const material = new THREE.MeshStandardNodeMaterial({
      map,
      // Cutout rather than blended: sorted transparency at instance counts like these
      // is not something any renderer here is going to do, and alpha test is what the
      // real pipeline would ship anyway.
      alphaTest: 0.45,
      transparent: false,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0,
    });
    material.name = name;
    materials.push(material);

    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < count; i++) {
      const x = (random() * 2 - 1) * extent;
      const z = (random() * 2 - 1) * extent;
      const y = heightAt(x, z);
      position.set(x, y, z);
      quaternion.setFromAxisAngle(up, random() * Math.PI * 2);
      const s = scaleRange[0] + random() * (scaleRange[1] - scaleRange[0]);
      scale.set(s, s * (0.85 + random() * 0.4), s);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    // Culling the whole scatter as one sphere is wrong for a 340 m spread; keeping it
    // in every frame is the honest thing while frame time is being measured.
    mesh.frustumCulled = false;

    group.add(mesh);
    layers.push({
      mesh,
      baseTriangles: (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3,
      instanceCount: count,
    });
  };

  build('grass_cluster', crossedCards(0.5, 0.75, 3), createBladeTexture('grass'), grassCount, [0.8, 1.9]);
  build('fern', crossedCards(1.3, 1.1, 2), createBladeTexture('fern'), fernCount, [0.7, 1.6]);

  // `animatesVertices` is a lie here — nothing sways yet — but foliage is the one
  // thing that will, and tagging it now keeps the eventual wind pass from silently
  // inheriting a cached shadow layer it is not allowed to use.
  applyMobility(group, Mobility.Static);
  group.traverse((object) => object.layers.enable(Layer.GiStatic));

  return { object: group, layers, materials };
}
