import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three/webgpu';
import { applyMobility, Mobility } from '../world/index.ts';
import { installStaticMotion } from '../render/vertexMotion.ts';

export interface PrefabPart {
  id: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  matrix?: THREE.Matrix4;
  tint?: boolean;
}

export interface PrefabInstance {
  id: string;
  matrix: THREE.Matrix4;
  color?: THREE.ColorRepresentation;
}

function instanceMotionEnabled(): boolean {
  return new URLSearchParams(window.location.search).get('instanceMotion') !== '0';
}

export function instanceTransform(position: number[], scale: number[] = [1, 1, 1], rotation: number[] = [0, 0, 0]): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3().fromArray(position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation as [number, number, number])), new THREE.Vector3().fromArray(scale));
}

function PartInstances({ part, instances, name }: { part: PrefabPart; instances: PrefabInstance[]; name: string }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const data = useMemo(() => ({ prefab: name, part: part.id, instanceIds: instances.map(i => i.id), lightmap: false }), [name, part.id, instances]);
  useLayoutEffect(() => {
    const mesh = ref.current!;
    const matrix = new THREE.Matrix4();
    instances.forEach((instance, index) => {
      matrix.copy(instance.matrix);
      if (part.matrix) matrix.multiply(part.matrix);
      mesh.setMatrixAt(index, matrix);
      if (part.tint) mesh.setColorAt(index, new THREE.Color(instance.color ?? '#ffffff'));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    applyMobility(mesh, Mobility.Static);
    if (instanceMotionEnabled()) installStaticMotion(part.material as THREE.NodeMaterial);
  }, [part, instances]);
  return <instancedMesh ref={ref} name={`${name}/${part.id}`} args={[part.geometry, part.material, instances.length]} userData={data} dispose={null} />;
}

export function MultiInstances({ name, parts, instances }: { name: string; parts: PrefabPart[]; instances: PrefabInstance[] }) {
  return <group name={name}>{parts.map(part => <PartInstances key={part.id} name={name} part={part} instances={instances} />)}</group>;
}
