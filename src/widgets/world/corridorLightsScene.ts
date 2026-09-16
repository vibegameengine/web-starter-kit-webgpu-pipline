import * as THREE from 'three/webgpu';
import type GUI from 'lil-gui';
import { Layer, Mobility, applyMobility } from '../../shared/world/index.ts';
import { createCorridorScene, type CorridorScene } from './corridorScene.ts';

export async function createCorridorLightsScene(renderer: THREE.WebGPURenderer): Promise<CorridorScene & { bindGui(gui: GUI): void }> {
  const corridor = await createCorridorScene(renderer);
  const params = new URLSearchParams(window.location.search);
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = params.has(key) ? Number(params.get(key)) : fallback;
    return Number.isFinite(value) ? THREE.MathUtils.clamp(value, min, max) : fallback;
  };
  const settings = {
    animate: params.get('lightMotion') !== '0',
    speed: number('lightSpeed', 1, 0, 3),
    power: number('lightPower', 1, 0, 3),
    amber: true,
    cyan: true,
    rose: true,
  };
  const definitions = [
    { key: 'amber', label: 'Тёплый', color: 0xff9a42, x: 1.3, z: -0.8, phase: 0, intensity: 24 },
    { key: 'cyan', label: 'Голубой', color: 0x42cfff, x: -2.4, z: 0.8, phase: 2.1, intensity: 30 },
    { key: 'rose', label: 'Розовый', color: 0xff527c, x: -6.4, z: -0.4, phase: 4.2, intensity: 22 },
  ] as const;
  const markerGeometry = new THREE.SphereGeometry(0.075, 16, 10);
  const lamps = definitions.map((definition) => {
    const light = new THREE.PointLight(definition.color, 0, 8, 2);
    light.name = `corridor-light-${definition.key}`;
    applyMobility(light, Mobility.Movable);
    light.castShadow = true;
    light.shadow.mapSize.set(512, 512);
    light.shadow.camera.near = 0.05;
    light.shadow.camera.far = 8;
    light.shadow.normalBias = 0.015;
    const marker = new THREE.Mesh(markerGeometry, new THREE.MeshBasicNodeMaterial({ color: definition.color }));
    marker.name = `${light.name}-bulb`;
    marker.layers.set(Layer.Debug);
    corridor.scene.add(light, marker);
    return { light, marker, definition };
  });
  let time = number('lightTime', 0, 0, 3600);
  let previous: number | undefined;
  let ready = false;
  const placeLights = () => {
    for (const { light, marker, definition } of lamps) {
      const phase = time * 0.65 + definition.phase;
      light.position.set(definition.x + Math.sin(phase) * 1.25, 1.65 + Math.sin(phase * 1.3) * 0.3, definition.z + Math.cos(phase) * 0.5);
      light.intensity = ready && settings[definition.key] ? definition.intensity * settings.power : 0;
      marker.position.copy(light.position);
      marker.visible = light.intensity > 0;
    }
  };
  placeLights();
  return {
    ...corridor,
    update(elapsedSeconds) {
      const dt = previous === undefined ? 0 : Math.min(0.1, Math.max(0, elapsedSeconds - previous));
      previous = elapsedSeconds;
      if (settings.animate) time += dt * settings.speed;
      placeLights();
    },
    bindGui(gui) {
      /* @important The host GUI is bound after the startup bake. Keep moving lights at zero until
         then so their initial poses do not leave permanent coloured patches in the static atlas. */
      ready = true;
      placeLights();
      const folder = gui.addFolder('Свет · коридор');
      folder.domElement.parentElement?.prepend(folder.domElement);
      folder.add(settings, 'animate').name('Движение');
      folder.add(settings, 'speed', 0, 3, 0.05).name('Скорость');
      folder.add(settings, 'power', 0, 3, 0.05).name('Мощность').onChange(placeLights);
      for (const definition of definitions) folder.add(settings, definition.key).name(definition.label).onChange(placeLights);
      folder.add({ reset() { time = 0; placeLights(); } }, 'reset').name('Сброс движения');
      folder.open();
    },
  };
}
