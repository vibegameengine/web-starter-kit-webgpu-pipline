import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type * as THREE from 'three/webgpu';
import { applyMobility, Mobility } from '../world/index.ts';

export function StaticGroup({ children, name, position, lightmap }: { children: ReactNode; name: string; position?: [number, number, number]; lightmap?: boolean }) {
  const ref = useRef<THREE.Group>(null);
  useLayoutEffect(() => {
    applyMobility(ref.current!, Mobility.Static);
    if (lightmap !== undefined) ref.current!.traverse(object=>{object.userData.lightmap=lightmap;});
  }, [children,lightmap]);
  return <group ref={ref} name={name} position={position}>{children}</group>;
}
