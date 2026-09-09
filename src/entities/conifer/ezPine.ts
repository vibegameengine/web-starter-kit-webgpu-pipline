import * as THREE from 'three/webgpu';
import { Tree } from '@dgreenheck/ez-tree';

export type EzPreset = 'Pine Small' | 'Pine Medium' | 'Pine Large' | 'Bush 1' | 'Bush 2' | 'Bush 3';

export interface EzPineOptions {
  seed: number;
  height: number;
  preset?: EzPreset;
  bakeIntoLightmap?: boolean;
}

export interface EzPine {
  group: THREE.Group;
  triangleCount: number;
}

function tallestSide(object: THREE.Object3D): number {
  const box = new THREE.Box3().setFromObject(object);
  return Math.max(0.001, box.max.y - box.min.y);
}

function countTriangles(root: THREE.Object3D): number {
  let total = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const index = mesh.geometry.getIndex();
    total += index ? index.count / 3 : mesh.geometry.getAttribute('position').count / 3;
  });
  return total;
}

/**
 * @important ez-tree ships its own MeshStandardMaterial and the renderer here is WebGPU:
 * a plain material still draws, but a node material is what the frame graph's G-buffer,
 * shadow and GI passes are written against, so every material is replaced after generate().
 */
export function createEzPine(options: EzPineOptions): EzPine {
  const tree = new Tree();
  tree.loadPreset(options.preset ?? 'Pine Large');
  tree.options.seed = options.seed;
  tree.generate();

  const scale = options.height / tallestSide(tree);
  tree.scale.setScalar(scale);
  tree.updateMatrixWorld(true);

  tree.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.material = toNodeMaterial(mesh.material as THREE.Material);
    if (options.bakeIntoLightmap === false) mesh.userData.lightmap = false;
  });
  tree.leavesMesh.userData.lightmap = false;
  tree.leavesMesh.material = leafMaterialOf(tree.leavesMesh.material as THREE.MeshStandardNodeMaterial);

  const group = new THREE.Group();
  group.name = `ezPine-${options.seed}`;
  group.add(tree);
  return { group, triangleCount: countTriangles(tree) };
}

function leafMaterialOf(material: THREE.MeshStandardNodeMaterial): THREE.MeshStandardNodeMaterial {
  material.side = THREE.DoubleSide;
  material.alphaTest = Math.max(0.3, material.alphaTest);
  material.name = 'ezLeaves';
  return material;
}

function toNodeMaterial(source: THREE.Material): THREE.MeshStandardNodeMaterial {
  const standard = source as THREE.MeshStandardMaterial;
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = standard.name || 'ezPine';
  material.map = standard.map ?? null;
  material.normalMap = standard.normalMap ?? null;
  material.roughnessMap = standard.roughnessMap ?? null;
  material.aoMap = standard.aoMap ?? null;
  material.color.copy(standard.color ?? new THREE.Color(1, 1, 1));
  material.roughness = standard.roughness ?? 0.9;
  material.metalness = 0;
  material.side = standard.side ?? THREE.FrontSide;
  material.transparent = false;
  material.alphaTest = standard.alphaTest ?? 0;
  material.userData.lightmapAlbedo = true;
  return material;
}
