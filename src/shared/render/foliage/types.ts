import type { DataTexture } from 'three/webgpu';

export interface LeafSurface {
  normal: DataTexture;
  roughness: DataTexture;
}
