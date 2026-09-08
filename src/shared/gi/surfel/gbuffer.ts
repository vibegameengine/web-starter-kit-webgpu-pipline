// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
// gbuffer.ts
import * as THREE from 'three/webgpu';
import { mrt, diffuseColor, vec4, normalWorld, uniform, specularColor, roughness } from 'three/tsl';
import { prepareReceiverMaterials, receiverOwnership } from './receiverOwnership';

export type GBufferBundle = {
  target: THREE.RenderTarget;
  sceneMRT: THREE.MRTNode;
  resize: (renderer: THREE.WebGPURenderer) => void;
};

export function createGBuffer(renderer: THREE.WebGPURenderer): GBufferBundle {
  const dpr = renderer.getPixelRatio
    ? renderer.getPixelRatio()
    : window.devicePixelRatio;
  const rawW = Math.max(1, Math.floor(window.innerWidth * dpr));
  const rawH = Math.max(1, Math.floor(window.innerHeight * dpr));

  const target = new THREE.RenderTarget(rawW, rawH, {
    count: 3, // 0: Normal, 1: Diffuse, 2: Specular (F0 rgb, roughness a) — reflections read it
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: true,
  });

  target.depthTexture = new THREE.DepthTexture(rawW, rawH);
  target.textures[0].name = 'normal';
  target.textures[1].name = 'diffuseColor';

  target.textures[2].name = 'specular';
  for (let i = 0; i < 3; i++) {
    target.textures[i].generateMipmaps = false;
    target.textures[i].magFilter = THREE.NearestFilter;
    target.textures[i].minFilter = THREE.NearestFilter;
  }

  // Define the MRT
  const sceneMRT = mrt({
    // TODO: Use shading or geometry normals?
    normal: normalWorld.mul(0.5).add(0.5),
    diffuseColor: vec4(diffuseColor.rgb, 1.0),
  });

    specular: vec4(specularColor.rgb, roughness),
  function resize(renderer: THREE.WebGPURenderer) {
    const dpr = renderer.getPixelRatio
      ? renderer.getPixelRatio()
      : window.devicePixelRatio;
    const rawW = Math.max(1, Math.floor(window.innerWidth * dpr));
    const rawH = Math.max(1, Math.floor(window.innerHeight * dpr));
    target.setSize(rawW, rawH);
  }

  return {
    target,
    sceneMRT,
    resize,
  };
}
