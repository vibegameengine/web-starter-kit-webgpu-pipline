import { createContext, useContext } from 'react';
import * as THREE from 'three/webgpu';
import limestoneAlbedo from './assets/limestone-albedo.png?url';
import limestoneNormal from './assets/limestone-normal.jpg?url';
import plasterAlbedo from './assets/plaster-albedo.png?url';
import pineNeedles from './assets/pine-needles.png?url';
import terracottaAlbedo from './assets/terracotta-albedo.png?url';
import bougainvilleaSpray from './assets/bougainvillea-spray.png?url';
import bougainvilleaLeaves from './assets/bougainvillea-leaves.png?url';
import oliveLeaves from './assets/olive-leaves.png?url';
import { createVillageFoliageMaterials } from './foliageMaterials.ts';

export interface VillageMaterials { limestone: THREE.MeshStandardNodeMaterial; plaster: THREE.Texture; pine: THREE.Texture; terracotta: THREE.Texture; bougainvillea: THREE.Texture; leaves: THREE.Texture; olive: THREE.Texture; foliage: ReturnType<typeof createVillageFoliageMaterials> }
export const VillageMaterialsContext = createContext<VillageMaterials | null>(null);

export function useVillageMaterials(): VillageMaterials {
  const materials = useContext(VillageMaterialsContext);
  if (!materials) throw new Error('Village prefab requires VillageMaterialsContext');
  return materials;
}

export async function loadVillageMaterials(environment: THREE.Texture): Promise<VillageMaterials> {
  const loader = new THREE.TextureLoader();
  const [albedo,normal,plaster,pine,terracotta,bougainvillea,leaves,olive] = await Promise.all([
    loader.loadAsync(limestoneAlbedo),
    loader.loadAsync(limestoneNormal),
    loader.loadAsync(plasterAlbedo),
    loader.loadAsync(pineNeedles),
    loader.loadAsync(terracottaAlbedo),
    loader.loadAsync(bougainvilleaSpray),
    loader.loadAsync(bougainvilleaLeaves),
    loader.loadAsync(oliveLeaves),
  ]);
  albedo.colorSpace=THREE.SRGBColorSpace;
  normal.colorSpace=THREE.NoColorSpace;
  plaster.colorSpace=THREE.SRGBColorSpace;
  pine.colorSpace=THREE.SRGBColorSpace;
  pine.anisotropy=8;
  bougainvillea.colorSpace=THREE.SRGBColorSpace;
  bougainvillea.anisotropy=8;
  leaves.colorSpace=THREE.SRGBColorSpace;
  leaves.anisotropy=8;
  olive.colorSpace=THREE.SRGBColorSpace;
  olive.anisotropy=8;
  terracotta.colorSpace=THREE.SRGBColorSpace;
  for(const t of [albedo,normal,plaster,terracotta]){t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=8;}
  const foliage=createVillageFoliageMaterials(environment,{pine,leaves,olive,bougainvillea});
  return {limestone:new THREE.MeshStandardNodeMaterial({map:albedo,normalMap:normal,normalScale:new THREE.Vector2(.16,.16),color:'#ded5bf',roughness:.93}),plaster,pine,terracotta,bougainvillea,leaves,olive,foliage};
}
