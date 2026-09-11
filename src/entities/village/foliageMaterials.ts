import type { Texture } from 'three/webgpu';
import { createTexturedLeafMaterial } from '../../shared/render/foliage/index.ts';

export function createVillageFoliageMaterials(environment: Texture, maps: { pine: Texture; leaves: Texture; olive: Texture; bougainvillea: Texture }) {
  return {
    pine: createTexturedLeafMaterial({ name: 'village-pine-leaves', map: maps.pine, environment, vertexTint: true, roughnessFront: .55, roughnessBack: .8, transmissionScale: .3, meanTransmittance: .05 }),
    cypress: createTexturedLeafMaterial({ name: 'village-cypress-leaves', map: maps.pine, environment, tint: '#879c69', roughnessFront: .58, roughnessBack: .82, transmissionScale: .24, meanTransmittance: .04 }),
    olive: createTexturedLeafMaterial({ name: 'village-olive-leaves', map: maps.olive, environment, vertexTint: true, roughnessFront: .46, roughnessBack: .8, transmissionScale: .42, meanTransmittance: .08 }),
    citrus: createTexturedLeafMaterial({ name: 'village-citrus-leaves', map: maps.leaves, environment, vertexTint: true, roughnessFront: .35, roughnessBack: .7, transmissionScale: .58, meanTransmittance: .12 }),
    bougainvilleaLeaves: createTexturedLeafMaterial({ name: 'village-bougainvillea-leaves', map: maps.leaves, environment, vertexTint: true, roughnessFront: .48, roughnessBack: .78, transmissionScale: .48, meanTransmittance: .1 }),
    bougainvilleaFlowers: createTexturedLeafMaterial({ name: 'village-bougainvillea-bracts', map: maps.bougainvillea, environment, vertexTint: true, roughnessFront: .72, roughnessBack: .88, transmissionScale: .32, meanTransmittance: .08 }),
  };
}
