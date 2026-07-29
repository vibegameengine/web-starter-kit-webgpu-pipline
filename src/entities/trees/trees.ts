import * as THREE from 'three/webgpu';
import { Tree } from '@dgreenheck/ez-tree';

import { Layer, Mobility, applyMobility } from '../../shared/world/index.ts';

export interface TreesOptions {
  count?: number;
  extent?: number;
  seed?: number;
  /** Preset names from ez-tree's `TreePreset`, cycled over `count`. */
  presets?: string[];
  heightAt: (x: number, z: number) => number;
}

export interface Trees {
  object: THREE.Group;
  triangleCount: number;
  materials: THREE.Material[];
  meshes: THREE.Mesh[];
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
 * ez-tree ships `MeshPhongMaterial` and patches it through `onBeforeCompile`, which is
 * a GLSL-string hook the WebGPU backend never calls. Rather than leave a material whose
 * declared behaviour silently does not happen, swap in the node material the rest of
 * this scene uses and keep only what actually survives: base colour, colour map, alpha
 * cutoff, sidedness.
 */
function toNodeMaterial(source: THREE.Material): THREE.MeshStandardNodeMaterial {
  const phong = source as THREE.Material & {
    color?: THREE.Color;
    map?: THREE.Texture | null;
    alphaTest?: number;
    side?: THREE.Side;
    name?: string;
  };
  const material = new THREE.MeshStandardNodeMaterial({
    color: phong.color ? phong.color.clone() : new THREE.Color(0xffffff),
    roughness: 0.9,
    metalness: 0,
    side: phong.side ?? THREE.FrontSide,
  });
  if (phong.map) material.map = phong.map;
  if (phong.alphaTest) {
    material.alphaTest = phong.alphaTest;
    material.transparent = false;
  }
  material.name = phong.name ?? 'tree';
  return material;
}

/**
 * A handful of procedural trees, each a distinct mesh with its own bark and leaf
 * material.
 *
 * Not instanced, unlike the ground cover, and that is on purpose: trees are the part of
 * the scene the BVH *does* see in full, so they are what makes the triangle count and
 * the build time move. Every tree added is another ~10 k triangles merged into the one
 * flat BVH that gets uploaded whole.
 */
export function createTrees(options: TreesOptions): Trees {
  const {
    count = 6,
    extent = 90,
    seed = 7,
    presets = ['Oak Medium', 'Ash Medium', 'Pine Medium', 'Aspen Medium'],
    heightAt,
  } = options;

  const random = mulberry32(seed);
  const group = new THREE.Group();
  group.name = 'trees';
  const materials: THREE.Material[] = [];
  const meshes: THREE.Mesh[] = [];
  let triangleCount = 0;

  for (let i = 0; i < count; i++) {
    const tree = new Tree();
    tree.loadPreset(presets[i % presets.length]);
    tree.options.seed = Math.floor(random() * 100000);
    tree.generate();

    const x = (random() * 2 - 1) * extent;
    const z = (random() * 2 - 1) * extent;
    tree.position.set(x, heightAt(x, z), z);
    tree.rotation.y = random() * Math.PI * 2;
    const scale = 0.8 + random() * 0.7;
    tree.scale.setScalar(scale);

    // ez-tree always allocates a branches mesh and a leaves mesh; presets that use
    // neither leave an empty one behind. An empty mesh is not free downstream — it
    // still claims a diffuse-array layer and a block of lightmap atlas cells — so it
    // goes rather than being tolerated.
    const empties: THREE.Object3D[] = [];
    tree.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const position = mesh.geometry?.getAttribute('position');
      const triangles = mesh.geometry?.index
        ? mesh.geometry.index.count / 3
        : (position?.count ?? 0) / 3;
      if (!position || triangles === 0) {
        empties.push(mesh);
        return;
      }
      const swapped = toNodeMaterial(
        Array.isArray(mesh.material) ? mesh.material[0] : mesh.material,
      );
      mesh.material = swapped;
      materials.push(swapped);
      meshes.push(mesh);
      triangleCount += triangles;
    });
    for (const empty of empties) empty.removeFromParent();

    group.add(tree);
  }

  applyMobility(group, Mobility.Static);
  group.traverse((object) => object.layers.enable(Layer.GiStatic));

  return { object: group, triangleCount, materials, meshes };
}
