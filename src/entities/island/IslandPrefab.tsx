import { useFrame } from '@vibegameengine/react-three-fiber';
import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { StaticGroup } from '../../shared/fiber/index.ts';
import type { Island } from './index.ts';

export function IslandPrefab({ island, sun }: { island: Island; sun: THREE.DirectionalLight }) {
  const direction = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ clock }) => island.update(clock.elapsedTime, sun.color, direction.copy(sun.position).sub(sun.target.position).normalize()));
  return <StaticGroup name="island">
    {[island.sand, ...island.walls, island.bottom].map(source => <mesh key={source.uuid} name={source.name} geometry={source.geometry} material={source.material} position={source.position} rotation={source.rotation} scale={source.scale} userData={source.userData} dispose={null} />)}
  </StaticGroup>;
}
