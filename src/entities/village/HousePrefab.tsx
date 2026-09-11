import { useMemo } from 'react';
import { DoubleSide } from 'three/webgpu';
import { StaticGroup } from '../../shared/fiber/index.ts';
import type { VillageHouse } from './layout.ts';
import { roofGeometry, gableGeometry, houseWallGeometry } from './geometry.ts';
import { useVillageMaterials } from './materials.tsx';

export function HousePrefab({ house }: { house: VillageHouse }) {
  const {plaster}=useVillageMaterials();
  const walls=useMemo(()=>houseWallGeometry(house),[house]);
  const roof = useMemo(() => roofGeometry(house.width + .3, house.depth + .3, house.roofRise, house.hip), [house.width, house.depth, house.hip, house.roofRise]);
  const gable = useMemo(() => house.hip ? null : gableGeometry(house.width,house.depth,house.roofRise), [house.width,house.depth,house.roofRise,house.hip]);
  return <StaticGroup name={house.id} position={[house.x, house.base, house.z]}>
    <mesh name={`${house.id}-walls`} geometry={walls}>
      <meshStandardMaterial color={house.wall} map={plaster} roughness={.92} />
    </mesh>
    {gable && <mesh name={`${house.id}-plaster-gables`} position={[0,house.height-.01,0]} geometry={gable}><meshStandardMaterial color={house.wall} map={plaster} roughness={.92}/></mesh>}
    <mesh name={`${house.id}-roof`} position={[0, house.height, 0]} geometry={roof}>
      <meshStandardMaterial color="#b96c3f" roughness={.88} side={DoubleSide} />
    </mesh>
  </StaticGroup>;
}
