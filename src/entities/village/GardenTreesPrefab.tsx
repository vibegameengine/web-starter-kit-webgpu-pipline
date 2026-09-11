import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { MultiInstances, instanceTransform } from '../../shared/fiber/index.ts';
import { gardenTreeParts } from './gardenTreeGeometry.ts';
import { useVillageMaterials } from './materials.tsx';

export function GardenTreesPrefab() {
  const { foliage } = useVillageMaterials();
  const olives = useMemo(() => gardenTreeParts('olive', foliage.olive), [foliage.olive]);
  const lemons = useMemo(() => gardenTreeParts('lemon', foliage.citrus), [foliage.citrus]);
  const oliveInstances = useMemo(() => [
    { id: 'cafe-courtyard-olive', matrix: instanceTransform([6.75, 2.9, -7.7], [1, 1, 1], [0, 1.4, 0]) },
  ], []);
  const lemonPlacements = useMemo(() => [
    { id: 'piazza-lemon', position: [2.1, 1.5, -2.15], scale: 1, angle: .8 },
    { id: 'pine-terrace-lemon', position: [-5.7, 2.9, -4.4], scale: .78, angle: 2.4 },
  ], []);
  const lemonInstances = useMemo(() => lemonPlacements.map(p => ({ id: p.id, matrix: instanceTransform([p.position[0], p.position[1] + .48 * p.scale, p.position[2]], [p.scale, p.scale, p.scale], [0, p.angle, 0]) })), [lemonPlacements]);
  const containers = useMemo(() => [
    { id: 'earthenware-tub', geometry: new THREE.LatheGeometry([[.22, 0], [.26, .04], [.34, .44], [.38, .48], [.38, .55], [.32, .55], [.31, .48], [.29, .44]].map(p => new THREE.Vector2(...p as [number, number])), 24), material: new THREE.MeshStandardNodeMaterial({ color: '#bf8656', roughness: .91 }) },
    { id: 'soil', geometry: new THREE.CylinderGeometry(.295, .295, .03, 18).translate(0, .455, 0), material: new THREE.MeshStandardNodeMaterial({ color: '#514335', roughness: 1 }) },
    { id: 'pot-band', geometry: new THREE.TorusGeometry(.287, .012, 5, 24).rotateX(Math.PI / 2).translate(0, .2, 0), material: new THREE.MeshStandardNodeMaterial({ color: '#8d7355', roughness: .89 }) },
  ], []);
  const potInstances = useMemo(() => lemonPlacements.map(p => ({ id: `${p.id}-pot`, matrix: instanceTransform(p.position, [p.scale, p.scale, p.scale]) })), [lemonPlacements]);
  return <group name="mediterranean-garden-trees">
    <MultiInstances name="courtyard-olives" parts={olives} instances={oliveInstances}/>
    <MultiInstances name="terrace-lemon-trees" parts={lemons} instances={lemonInstances}/>
    <MultiInstances name="fruit-tree-containers" parts={containers} instances={potInstances}/>
  </group>;
}
