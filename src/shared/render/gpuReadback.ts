import * as THREE from 'three/webgpu';

/** Inspector export in linear HDR, without tone mapping or colour conversion. */
export async function readFloatTexture(renderer: THREE.WebGPURenderer, texture: THREE.Texture) {
  const { width, height } = texture.image as { width: number; height: number };
  const wrapper = new THREE.RenderTarget(width, height);
  const unusedTexture = wrapper.texture;
  wrapper.textures = [texture];
  let raw: Awaited<ReturnType<THREE.WebGPURenderer['readRenderTargetPixelsAsync']>>;
  try {
    raw = await renderer.readRenderTargetPixelsAsync(wrapper, 0, 0, width, height);
  } finally {
    wrapper.textures = [unusedTexture];
    wrapper.dispose();
  }
  const floats = raw instanceof Uint16Array
    ? Float32Array.from(raw, THREE.DataUtils.fromHalfFloat)
    : Float32Array.from(raw);
  return { width, height, data: floats };
}

export async function readValidationTexture(renderer: THREE.WebGPURenderer, texture: THREE.Texture) {
  const { width, height, data } = await readFloatTexture(renderer, texture);
  const bytes = new Uint8Array(data.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return { width, height, channels: 4, format: 'rgba32f-le', origin: 'top-left', data: btoa(binary) };
}
