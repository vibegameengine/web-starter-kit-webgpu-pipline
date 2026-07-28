import * as THREE from 'three/webgpu';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { createScene } from '../../shared/gi/surfel/scene.ts';
import {
  addDynamicDemoObject,
  populateCornellScene,
  type DynamicObject,
} from '../../shared/gi/surfel/content.ts';
import { Layer, Mobility, applyMobility } from '../../shared/world/index.ts';

export interface CornellScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sun: THREE.DirectionalLight;
  update: (elapsedSeconds: number) => void;
}

/**
 * webgiya's Cornell Box, unmodified.
 *
 * Geometry, materials, camera and the orbiting demo sphere all come from the ported
 * `scene.ts` / `content.ts` rather than being re-authored here. That is deliberate:
 * the point of this scene is to be a *reference frame*, so that any difference from
 * webgiya's own output is a bug in the port and nothing else. Authored content
 * arrives in Phase 6, once the graph around it is trusted.
 *
 * The one addition is mobility tagging, which upstream has no concept of — the walls
 * are Static (they are what the BVH is built from), the demo sphere is Movable and is
 * added *after* the BVH build so it never enters it.
 */
export function createCornellScene(renderer: THREE.WebGPURenderer): CornellScene {
  const { scene, camera, controls, dirLight } = createScene(renderer);

  // webgiya's Cornell camera preset (content.ts SCENE_PRESETS['cornell-box']).
  camera.position.set(0, 2.3, 11);
  controls.target.set(0, 2.3, 1);
  controls.update();

  // The viewport camera may see debug gizmos; no other pass enables that layer.
  camera.layers.enable(Layer.Debug);

  return {
    scene,
    camera,
    controls,
    sun: dirLight,
    update: () => {},
  };
}

/** Builds the static contents. Must run before the BVH is built. */
export function populateCornell(scene: THREE.Scene, sun: THREE.DirectionalLight): void {
  populateCornellScene(scene, sun);
  applyMobility(scene, Mobility.Static);
}

/**
 * Adds the orbiting sphere. Called *after* the BVH build, so it is raster/shadow only
 * and never becomes part of the static world representation — the same split webgiya
 * uses, and the same one UE enforces through mobility.
 */
export function addDynamicSphere(scene: THREE.Scene): DynamicObject {
  const dynamic = addDynamicDemoObject(scene);
  applyMobility(dynamic.mesh, Mobility.Movable);
  return dynamic;
}
