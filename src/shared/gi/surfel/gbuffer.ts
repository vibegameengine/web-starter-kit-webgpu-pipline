// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
// gbuffer.ts
import * as THREE from 'three/webgpu';
import { mrt, diffuseColor, vec4, normalWorldGeometry, normalWorld } from 'three/tsl';

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
    count: 2, // 0: Normal, 1: Diffuse
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: true,
  });

  target.depthTexture = new THREE.DepthTexture(rawW, rawH);
  target.textures[0].name = 'normal';
  target.textures[1].name = 'diffuseColor';

  for (let i = 0; i < 2; i++) {
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
