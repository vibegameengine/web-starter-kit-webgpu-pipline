import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { MultiInstances, instanceTransform } from '../../shared/fiber/index.ts';
import { HousePrefab } from './HousePrefab.tsx';
import { VILLAGE_HOUSES, VILLAGE_TERRACES, VILLAGE_PLOT } from './layout.ts';
import { VillageWindows, VillageDoors } from './WindowPrefabs.tsx';
import { TerraceSteps, QuayMasonry, QuayPaving } from './TerracePrefabs.tsx';
import { RoofTiles } from './RoofPrefabs.tsx';
import { pineParts as createPineParts } from './pineGeometry.ts';
import { useVillageMaterials } from './materials.tsx';
import { BellTowerPrefab } from './BellTowerPrefab.tsx';
import { BoatPrefab } from './BoatPrefab.tsx';
import { PlantingPrefab } from './PlantingPrefab.tsx';
import { CafePrefab } from './CafePrefab.tsx';
import { HarborDetails } from './HarborDetails.tsx';
import { CypressPrefab } from './CypressPrefab.tsx';
import { TerraceGrotto } from './TerraceGrotto.tsx';
import { RoofAccessories } from './RoofAccessories.tsx';
import { GardenTreesPrefab } from './GardenTreesPrefab.tsx';

export function VillagePrefab() {
  const materials = useVillageMaterials();
  const foundationParts = useMemo(() => [{ id:'masonry',geometry:new THREE.BoxGeometry(1,1,1),material:materials.limestone }], [materials]);
  const foundations = useMemo(() => VILLAGE_TERRACES.filter(t=>t.id!=='pine-terrace').map(t=>({id:t.id,matrix:instanceTransform([(t.x0+t.x1)/2,(t.top+VILLAGE_PLOT.bottom)/2,(t.z0+t.z1)/2],[t.x1-t.x0,t.top-VILLAGE_PLOT.bottom,t.z1-t.z0])})), []);
  const pines = useMemo(() => [[-6.8,-6.8,2.9,5.7,4.9],[-9,-3.3,2.9,3.25,2.6]].map(([x,z,b,h,w],i)=>({id:`pine-${i}`,matrix:instanceTransform([x,b,z],[w,h,w*.75])})), []);
  const pineParts = useMemo(()=>createPineParts(materials.foliage.pine), [materials.foliage.pine]);
  return <group name="midsee-village-prefab">
    <MultiInstances name="foundations" parts={foundationParts} instances={foundations}/>
    <TerraceGrotto/>
    {VILLAGE_HOUSES.map(house=><HousePrefab key={house.id} house={house}/>)}
    <VillageWindows/>
    <VillageDoors/>
    <TerraceSteps/>
    <QuayMasonry/>
    <QuayPaving/>
    <RoofTiles/>
    <RoofAccessories/>
    <BellTowerPrefab/>
    <MultiInstances name="umbrella-pines" parts={pineParts} instances={pines}/>
    <CypressPrefab/>
    <GardenTreesPrefab/>
    <BoatPrefab/>
    <PlantingPrefab/>
    <CafePrefab/>
    <HarborDetails/>
  </group>;
}
