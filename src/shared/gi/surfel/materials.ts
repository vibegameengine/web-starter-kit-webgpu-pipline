// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
import { float, color as tslColor } from 'three/tsl';
import * as THREE from 'three/webgpu';

export function makeNodeStandard(
  hex: number,
  roughness = 0.8,
  metalness = 0.0,
): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.colorNode = tslColor(hex);
  mat.color = new THREE.Color(hex);
  mat.roughnessNode = float(roughness);
  mat.metalnessNode = float(metalness);
  return mat;
}
