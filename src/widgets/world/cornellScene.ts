import * as THREE from 'three/webgpu';
import { color as tslColor } from 'three/tsl';
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
 * are Static and the demo sphere is Movable, and that tag is now the only thing that
 * decides which of the two acceleration structures a mesh lands in.
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
  // `?lamps=1` for all three, or any comma-separated subset of point/spot/emissive.
  // Separable because the acceptance claims are separable: "a spot light throws
  // indirect light" is not demonstrated by a capture in which a point light is also on.
  const lamps = new URLSearchParams(window.location.search).get('lamps') ?? '';
  if (lamps) {
    const want = lamps === '1' ? ['point', 'spot', 'emissive'] : lamps.split(',');
    addCornellLamps(scene, {
      point: want.includes('point'),
      spot: want.includes('spot'),
      emissive: want.includes('emissive'),
    });
  }
  applyMobility(scene, Mobility.Static);
}

/**
 * Three light sources that are not the sun, in three separable colours.
 *
 * This is a measuring instrument, not art direction. The GI knew about exactly one
 * directional light and no emission at all, and the only way to show that it now knows
 * about more is to put things in the box whose contribution can be isolated: a warm
 * point lamp low on the left, a violet spot high on the right, and a blue emissive
 * panel on the back wall. Distinct hues because the delta between two captures has to
 * be attributable to one of them, and a scene lit by three white lamps cannot say which
 * one moved.
 *
 * Off unless `?lamps=1`, so the default Cornell view stays the reference frame every
 * earlier measurement in this project was taken against.
 *
 * Positions are world-space. The box geometry is authored at 1/4 scale and lifted by
 * -0.5 (see `buildCornellScene`), so the interior runs x,z in ±4 and y in -0.5..5.5.
 */
export function addCornellLamps(
  scene: THREE.Scene,
  which: { point?: boolean; spot?: boolean; emissive?: boolean } = {},
): void {
  const { point: wantPoint = true, spot: wantSpot = true, emissive: wantEmissive = true } =
    which;

  // Warm point lamp, low and left, near the red wall. Inverse-square at ~1.7 m to the
  // floor puts its direct contribution in the same range as the sun's, which is what
  // makes its *indirect* contribution large enough to measure against frame noise.
  if (wantPoint) {
    const point = new THREE.PointLight(0xff8c33, 13, 16, 2);
    point.position.set(-2.2, 1.2, 1.6);
    point.name = 'cornellPointLamp';
    scene.add(point);
  }

  // Violet spot, high and right, aimed down at the short box. A spot rather than a
  // second point because the cone and its penumbra are the part of the light model
  // that a naive "position + colour" buffer silently drops.
  if (wantSpot) {
    // Intensity and reach chosen so its irradiance at the floor lands within a factor
    // of two of the point lamp's. Two lights whose contributions differ by an order of
    // magnitude cannot be ablated separately against the same frame noise floor.
    const spot = new THREE.SpotLight(0xb85cff, 110, 20, 0.5, 0.4, 2);
    spot.position.set(2.7, 4.2, 2.6);
    spot.target.position.set(1.2, -0.5, 1.2);
    spot.name = 'cornellSpotLamp';
    scene.add(spot);
    scene.add(spot.target);
  }

  if (!wantEmissive) return;

  // Blue emissive panel on the back wall. No light object of any kind is attached to
  // it: everything it contributes has to arrive through the emissive channel of the
  // diffuse array, which is the whole claim.
  const EMISSIVE_COLOUR = new THREE.Color(0.25, 0.55, 1.0);
  const EMISSIVE_INTENSITY = 9;

  const panelMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0x0a0a10,
    roughness: 1,
    metalness: 0,
  });
  // Set twice, on purpose, because two different consumers read two different things.
  // `emissive`/`emissiveIntensity` are what `diffuseArray.ts` bakes into the tracer's
  // emissive layers; `emissiveNode` is what the raster actually draws. The plain
  // properties alone leave the panel black on screen while it still throws indirect
  // light, which is the most confusing possible half-working state — the glow appears
  // and the thing casting it does not.
  panelMaterial.emissive = EMISSIVE_COLOUR;
  panelMaterial.emissiveIntensity = EMISSIVE_INTENSITY;
  panelMaterial.emissiveNode = tslColor(EMISSIVE_COLOUR).mul(EMISSIVE_INTENSITY);
  panelMaterial.name = 'cornellEmissivePanel';

  const panel = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.1, 0.12), panelMaterial);
  panel.position.set(0, 3.4, -3.9);
  panel.name = 'emissivePanel';
  scene.add(panel);
}

/**
 * Adds the orbiting sphere, tagged Movable. It must be in the scene *before* the BVH
 * build — not because the static structure wants it (mobility keeps it out) but because
 * that build is also where the shared diffuse array is baked, and a mover with no
 * material id in that array is a mover a ray can hit but not shade.
 */
export function addDynamicSphere(
  scene: THREE.Scene,
  options: { radius?: number } = {},
): DynamicObject {
  const dynamic = addDynamicDemoObject(scene, options);
  applyMobility(dynamic.mesh, Mobility.Movable);
  return dynamic;
}
