// @ts-nocheck -- based on jure/webgiya, with local baked receiver ownership.
// gbuffer.ts
import * as THREE from 'three/webgpu';
import { mrt, diffuseColor, vec4, normalWorld, uniform, specularColor, roughness } from 'three/tsl';
import { prepareReceiverMaterials, receiverOwnership } from './receiverOwnership';
import { giKnobs } from './knobs';

export type GBufferBundle = {
  target: THREE.RenderTarget;
  sceneMRT: THREE.MRTNode;
  resize: (renderer: THREE.WebGPURenderer, scaleOverride?: number) => void;
  prepareScene: (scene: THREE.Scene) => void;
};

export function createGBuffer(renderer: THREE.WebGPURenderer): GBufferBundle {
  let scale = giKnobs.giScale();
  const dpr = renderer.getPixelRatio
    ? renderer.getPixelRatio()
    : window.devicePixelRatio;
  const rawW = Math.max(1, Math.floor(window.innerWidth * dpr * scale));
  const rawH = Math.max(1, Math.floor(window.innerHeight * dpr * scale));

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

  // Match the compositor's receiver ownership without changing normal RGB.
  const bakedReceiver = uniform(0).onObjectUpdate(({ object }) => receiverOwnership(object));
  const sceneMRT = mrt({
    // TODO: Use shading or geometry normals?
    normal: vec4(normalWorld.mul(0.5).add(0.5), bakedReceiver),
    diffuseColor: vec4(diffuseColor.rgb, 1.0),
    specular: vec4(specularColor.rgb, roughness),
  });

  function resize(renderer: THREE.WebGPURenderer, scaleOverride?: number) {
    if (scaleOverride !== undefined) scale = scaleOverride;
    const dpr = renderer.getPixelRatio
      ? renderer.getPixelRatio()
      : window.devicePixelRatio;
    const rawW = Math.max(1, Math.floor(window.innerWidth * dpr * scale));
    const rawH = Math.max(1, Math.floor(window.innerHeight * dpr * scale));
    target.setSize(rawW, rawH);
  }

  return {
    target,
    sceneMRT,
    resize,
    prepareScene: prepareReceiverMaterials,
  };
}
