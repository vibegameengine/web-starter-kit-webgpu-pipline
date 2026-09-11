import { useLayoutEffect } from 'react';
import { useFrame } from '@vibegameengine/react-three-fiber';
import { Layer } from '../../shared/world/index.ts';
import type { Water } from './index.ts';

export function WaterPrefab({ water }: { water: Water }) {
  useLayoutEffect(() => {
    water.group.traverse(object => { object.layers.set(Layer.Overlay); object.userData.giExclude = true; });
  }, [water]);
  useFrame(({ clock }) => water.update(clock.elapsedTime));
  return <primitive object={water.group} dispose={null} />;
}
