import * as THREE from 'three/webgpu';
import { Layer, Mobility, applyMobility } from '../../shared/world/index.ts';
import type { WorldState } from '../../shared/world/index.ts';

export interface CornerScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  /** Everything that must be ticked each frame. */
  update: (world: WorldState) => void;
}

function surface(color: number, roughness = 0.9): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(color).convertSRGBToLinear(),
    roughness,
    metalness: 0,
  });
}

/**
 * The gate scene for phases 0–5.
 *
 * A Cornell-style corner, chosen over a cave or a forest because it exposes every
 * property the pipeline is judged on — coloured bounce, contact shadow, cache
 * invalidation, sun scrub — while staying small enough to iterate in seconds.
 * Content comes back in Phase 6, authored *into* the graph rather than in front of it.
 *
 * Mobility tagging is not decoration here: the walls and blocks are what the cached
 * shadow layer and the GI cache will be built from, and the orbiting sphere is the
 * thing that must keep updating while those caches stay untouched.
 */
export function createCornerScene(): CornerScene {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    500,
  );
  // Parked in front of the open side; the corner is only readable from outside it.
  camera.position.set(4.6, 4.9, 13.5);
  // The viewport camera may see debug gizmos; no other pass enables that layer.
  camera.layers.enable(Layer.Debug);

  // --- static shell --------------------------------------------------------
  const shell = new THREE.Group();
  shell.name = 'corner-shell';

  const W = 10;
  const H = 7;

  const floor = new THREE.Mesh(new THREE.BoxGeometry(W, 0.4, W), surface(0xb8b4ac));
  floor.position.set(0, -0.2, 0);
  shell.add(floor);

  const leftWall = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, H, W),
    surface(0xb02418),
  );
  leftWall.position.set(-W / 2, H / 2, 0);
  shell.add(leftWall);

  const rightWall = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, H, W),
    surface(0x1f8a2e),
  );
  rightWall.position.set(W / 2, H / 2, 0);
  shell.add(rightWall);

  const backWall = new THREE.Mesh(
    new THREE.BoxGeometry(W, H, 0.4),
    surface(0xb8b4ac),
  );
  backWall.position.set(0, H / 2, -W / 2);
  shell.add(backWall);

  // Open to the sky. A ceiling slot makes a pretty shaft but leaves both side walls
  // in shadow, so the only indirect signal is a second-order tint — too weak to prove
  // anything. Open-top puts direct sun on the red wall and the floor, which makes the
  // green wall's red bleed a yes/no test rather than a judgement call.
  // The ceiling comes back in Phase 4, when there is a volumetric pass to justify it.

  const tallBlock = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 3.4, 1.9),
    surface(0xc8c4bc),
  );
  tallBlock.position.set(-1.9, 1.7, -1.4);
  tallBlock.rotation.y = 0.28;
  shell.add(tallBlock);

  const shortBlock = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 1.9, 1.9),
    surface(0xc8c4bc),
  );
  shortBlock.position.set(2.1, 0.95, 1.2);
  shortBlock.rotation.y = -0.38;
  shell.add(shortBlock);

  applyMobility(shell, Mobility.Static);
  scene.add(shell);

  // --- the one moving thing ------------------------------------------------
  // Its shadow must keep updating every frame while the static shadow cache stays
  // at zero rebuilds. That contrast is the Phase 1 gate.
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.85, 48, 32),
    new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(0xe8b021).convertSRGBToLinear(),
      roughness: 0.35,
      metalness: 0,
    }),
  );
  sphere.name = 'orbiter';
  applyMobility(sphere, Mobility.Movable);
  scene.add(sphere);

  // --- sun ------------------------------------------------------------------
  const sun = new THREE.DirectionalLight(0xfff4e6, 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 260;
  sun.shadow.camera.left = -12;
  sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 12;
  sun.shadow.camera.bottom = -12;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);

  // No ambient light. Everything that is not direct sun comes from the traced
  // irradiance cache — a flat hemisphere here would mask exactly the term this
  // pipeline exists to compute.

  const update = (world: WorldState): void => {
    const t = world.time;
    sphere.position.set(Math.sin(t * 0.55) * 2.6, 1.6 + Math.sin(t * 1.3) * 0.55, Math.cos(t * 0.55) * 2.6);
  };

  return { scene, camera, sun, update };
}
