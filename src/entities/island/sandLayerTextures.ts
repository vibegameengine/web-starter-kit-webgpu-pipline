import * as THREE from 'three/webgpu';
import type { LayerMaps, LayerTextures } from '../../shared/render/terrain/layerMaps.ts';

const BASE_URL = 'art/sand';

const LAYER_FILES = ['dry-grain', 'wind-ripples', 'wet-sand', 'shell-litter'] as const;

function configure(texture: THREE.Texture, srgb: boolean): THREE.Texture {
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

async function loadPair(loader: THREE.TextureLoader, name: string): Promise<LayerTextures> {
  const [surface, detail] = await Promise.all([
    loader.loadAsync(`${BASE_URL}/${name}-surface.png`),
    loader.loadAsync(`${BASE_URL}/${name}-detail.png`),
  ]);
  return { surface: configure(surface, true) as THREE.DataTexture, detail: configure(detail, false) as THREE.DataTexture };
}

/**
 * @important The alpha channel of the surface map carries relief, and alpha is
 * never sRGB-encoded even in an sRGB texture, so height survives the colour space
 * the albedo needs. Packing it anywhere else costs a third texture per layer.
 */
export async function loadSandLayerMaps(): Promise<LayerMaps | null> {
  const loader = new THREE.TextureLoader();
  try {
    const layers = await Promise.all(LAYER_FILES.map((name) => loadPair(loader, name)));
    const size = layers[0].surface.image.width as number;
    return {
      layers,
      size,
      dispose: () => layers.forEach(({ surface, detail }) => {
        surface.dispose();
        detail.dispose();
      }),
    };
  } catch {
    return null;
  }
}
