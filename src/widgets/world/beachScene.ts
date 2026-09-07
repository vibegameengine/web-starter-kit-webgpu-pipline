import * as THREE from 'three/webgpu';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { createScene } from '../../shared/gi/surfel/scene.ts';
import { Layer, Mobility, applyMobility } from '../../shared/world/index.ts';
import { seededRandom } from '../../shared/lib/noise.ts';
import { IslandField, createIsland, type CliffTextures } from '../../entities/island/index.ts';
import { createWater, type Water } from '../../entities/water/index.ts';
import { createBackdrop } from '../../entities/backdrop/index.ts';
import { createRock, createRockMaterial, type RockTextures } from '../../entities/rocks/index.ts';
import { createPalm, type Palm } from '../../entities/palm/index.ts';
import { createShrub, type Shrub } from '../../entities/shrub/index.ts';
import { updateFoliageSun } from '../../entities/foliage/translucency.ts';

export interface BeachScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sun: THREE.DirectionalLight;
  water: Water;
  field: IslandField;
  /** Per-frame: wind, water, caustics. Static geometry never moves. */
  update: (elapsedSeconds: number) => void;
  /** The overlay pass hands the water the composited colour and the scene depth. */
  bindScreen: (color: THREE.Texture, depth: THREE.Texture) => void;
}

/**
 * The beach diorama from `concepts/beach.png`: a floating cut slab of coral sand with
 * a lagoon on its open front-left side, boulders along the back rim and in the water,
 * coconut palms and tropical undergrowth on the high back-right corner, all in front
 * of a neutral studio backdrop.
 *
 * Lit by the same pipeline as everything else: the slab, rocks and palm trunks are
 * Static and baked into the atlas; foliage is Static for the tracer (it occludes and
 * bounces) but opts out of the lightmap and is lit by live surfels because it moves
 * in the wind; water and backdrop are outside the GI entirely.
 */
export async function createBeachScene(renderer: THREE.WebGPURenderer, environment: THREE.Texture): Promise<BeachScene> {
  const { scene, camera, controls, dirLight: sun } = createScene(renderer);
  scene.background = null;

  camera.fov = 27;
  camera.near = 0.2;
  camera.far = 600;
  camera.updateProjectionMatrix();
  camera.position.set(-15.5, 14.5, 20.5);
  controls.target.set(0.4, -0.7, 0.0);
  // Close-up presets for judging detail: `?cam=shore|rocks|water|wide`.
  const presets: Record<string, [THREE.Vector3, THREE.Vector3]> = {
    shore: [new THREE.Vector3(1.8, 2.4, 6.5), new THREE.Vector3(0.2, -0.3, 1.5)],
    rocks: [new THREE.Vector3(-5.5, 3.0, 0.5), new THREE.Vector3(-2.5, -0.4, -3.8)],
    water: [new THREE.Vector3(-2.0, 3.5, 7.5), new THREE.Vector3(-1.5, -0.6, 1.5)],
  };
  const preset = presets[new URLSearchParams(window.location.search).get('cam') ?? ''];
  if (preset) {
    camera.position.copy(preset[0]);
    controls.target.copy(preset[1]);
  }
  controls.update();
  camera.layers.enable(Layer.Debug);

  // Sun: the direction is derived from the environment map by the app; here only the
  // shadow footprint, sized to the slab and its palms.
  // Sun and shadow are the pipeline's (features/lighting-pipeline); nothing here.

  // --- textures ------------------------------------------------------------------
  const base = import.meta.env.BASE_URL;
  const loader = new THREE.TextureLoader();
  const load = async (path: string, srgb: boolean) => {
    const tex = await loader.loadAsync(`${base}textures/${path}`);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    return tex;
  };
  const [rockColor, rockNormal, rockRoughness, rockAo, dirtColor, dirtNormal] = await Promise.all([
    load('rock/Rock030_2K-JPG_Color.jpg', true),
    load('rock/Rock030_2K-JPG_NormalGL.jpg', false),
    load('rock/Rock030_2K-JPG_Roughness.jpg', false),
    load('rock/Rock030_2K-JPG_AmbientOcclusion.jpg', false),
    load('dirt/Ground037_2K-JPG_Color.jpg', true),
    load('dirt/Ground037_2K-JPG_NormalGL.jpg', false),
  ]);
  const rockTextures: RockTextures = { map: rockColor, normalMap: rockNormal, roughnessMap: rockRoughness, aoMap: rockAo };
  const cliffTextures: CliffTextures = { rockColor, rockNormal, rockRoughness, dirtColor, dirtNormal };

  // --- island --------------------------------------------------------------------
  const field = new IslandField(7, 6, -3.2);
  const island = createIsland({ field, textures: cliffTextures });
  scene.add(island.group);
  applyMobility(island.group, Mobility.Static);

  // --- rocks ---------------------------------------------------------------------
  const dryRock = createRockMaterial(rockTextures, 'dry');
  const wetRock = createRockMaterial(rockTextures, 'submerged');
  const rocks = new THREE.Group();
  rocks.name = 'rocks';
  const random = seededRandom(1234);

  type RockSpec = { x: number; z: number; r: number; sink?: number; seed: number };
  // Back-left rim: the big cluster the reference frames the lagoon with.
  const rimRocks: RockSpec[] = [
    { x: -3.6, z: -4.9, r: 1.35, seed: 11 },
    { x: -2.2, z: -5.1, r: 1.1, seed: 12 },
    { x: -4.6, z: -3.9, r: 0.85, seed: 13 },
    { x: -1.1, z: -4.5, r: 0.75, seed: 14 },
    { x: -0.2, z: -5.3, r: 0.9, seed: 15 },
    { x: -3.0, z: -3.9, r: 0.55, seed: 16 },
    { x: -5.2, z: -5.0, r: 0.7, seed: 17 },
  ];
  // Right rim and the front-right corner, where the sand turns over the edge.
  const rightRocks: RockSpec[] = [
    { x: 5.3, z: -1.2, r: 0.9, seed: 21 },
    { x: 5.5, z: 0.4, r: 0.65, seed: 22 },
    { x: 4.6, z: -2.4, r: 0.55, seed: 23 },
    { x: 5.4, z: 2.1, r: 0.5, seed: 24 },
    { x: 3.9, z: 1.2, r: 0.35, seed: 25 },
    { x: 1.6, z: 4.9, r: 0.55, seed: 26 },
    { x: 3.2, z: 5.2, r: 0.4, seed: 27 },
  ];
  // In the lagoon: some breaking the surface, some fully under.
  const waterRocks: RockSpec[] = [
    { x: -3.4, z: -1.6, r: 0.75, sink: 0.35, seed: 31 },
    { x: -1.4, z: -2.6, r: 0.5, sink: 0.4, seed: 32 },
    { x: -4.4, z: 0.6, r: 0.55, sink: 0.55, seed: 33 },
    { x: -2.6, z: 1.9, r: 0.65, sink: 0.7, seed: 34 },
    { x: -3.9, z: 3.6, r: 0.45, sink: 0.6, seed: 35 },
    { x: -0.6, z: 1.2, r: 0.4, sink: 0.6, seed: 36 },
    { x: -5.0, z: -2.9, r: 0.6, sink: 0.3, seed: 37 },
  ];

  const place = (spec: RockSpec, material: THREE.MeshStandardNodeMaterial, submerged: boolean) => {
    const rock = createRock({ seed: spec.seed, radius: spec.r }, material);
    const ground = field.height(spec.x, spec.z);
    const sink = spec.sink ?? 0.25;
    rock.position.set(spec.x, ground + spec.r * (0.55 - sink), spec.z);
    rock.rotation.y = random() * Math.PI * 2;
    rock.rotation.x = (random() - 0.5) * 0.2;
    rocks.add(rock);
    if (submerged || ground < field.waterLevel + 0.3) {
      rock.geometry.computeBoundingBox();
      const box = rock.geometry.boundingBox!;
      field.addStamp(spec.x, spec.z, (box.max.x - box.min.x) * 0.42, (box.max.z - box.min.z) * 0.42, rock.position.y + box.max.y * 0.9);
    }
  };
  for (const spec of rimRocks) place(spec, dryRock, false);
  for (const spec of rightRocks) place(spec, dryRock, false);
  for (const spec of waterRocks) place(spec, wetRock, true);
  scene.add(rocks);
  applyMobility(rocks, Mobility.Static);

  // --- palms ---------------------------------------------------------------------
  const palms: Palm[] = [];
  const palmSpecs = [
    { x: 2.4, z: -4.3, h: 5.2, lean: -0.22, seed: 41 },
    { x: 3.9, z: -2.9, h: 4.5, lean: -0.12, seed: 42 },
    { x: 4.9, z: -4.7, h: 4.9, lean: 0.05, seed: 43 },
    { x: 1.0, z: -3.3, h: 3.7, lean: -0.3, seed: 44 },
  ];
  for (const spec of palmSpecs) {
    const palm = createPalm({ seed: spec.seed, height: spec.h, lean: spec.lean });
    palm.group.position.set(spec.x, field.height(spec.x, spec.z) - 0.05, spec.z);
    // Lean toward the water (−x), which is where the light and the camera are.
    palm.group.rotation.y = Math.PI + (random() - 0.5) * 0.6;
    scene.add(palm.group);
    tagFoliage(palm.group);
    palms.push(palm);
  }

  // --- undergrowth ---------------------------------------------------------------
  const shrubs: Shrub[] = [];
  const shrubSpecs: Array<{ x: number; z: number; r: number; kind: 'broadleaf' | 'fan' | 'mixed'; seed: number }> = [
    { x: 1.6, z: -4.8, r: 0.9, kind: 'mixed', seed: 51 },
    { x: 3.1, z: -3.7, r: 0.8, kind: 'broadleaf', seed: 52 },
    { x: 4.4, z: -3.9, r: 0.7, kind: 'fan', seed: 53 },
    { x: 0.3, z: -4.2, r: 0.75, kind: 'mixed', seed: 54 },
    { x: 5.0, z: -2.2, r: 0.6, kind: 'broadleaf', seed: 55 },
    { x: 2.6, z: -2.4, r: 0.55, kind: 'fan', seed: 56 },
    { x: 4.2, z: -0.4, r: 0.5, kind: 'mixed', seed: 57 },
    { x: 5.2, z: 1.3, r: 0.45, kind: 'fan', seed: 58 },
  ];
  for (const spec of shrubSpecs) {
    const shrub = createShrub({ seed: spec.seed, radius: spec.r, kind: spec.kind });
    shrub.group.position.set(spec.x, field.height(spec.x, spec.z) - 0.03, spec.z);
    shrub.group.rotation.y = random() * Math.PI * 2;
    scene.add(shrub.group);
    tagFoliage(shrub.group);
    shrubs.push(shrub);
  }

  // --- water and backdrop (outside the GI) -------------------------------------
  const water = createWater({ renderer, field, environment, sun });
  // The sand darkens where the simulated swash has been.
  water.onField = (fieldTexture) => island.setWetness(fieldTexture);
  scene.add(water.group);
  const backdrop = createBackdrop({ islandBottom: field.bottom, islandHalf: field.half });
  scene.add(backdrop);
  backdrop.traverse((object) => {
    object.layers.set(Layer.Debug);
    object.userData.giExclude = true;
  });
  // The water is drawn by the frame graph's overlay pass, after the composite, with
  // the scene colour and depth as inputs; no G-buffer camera sees this layer.
  water.group.traverse((object) => {
    object.layers.set(Layer.Overlay);
    object.userData.giExclude = true;
  });


  const sunDirection = new THREE.Vector3();
  return {
    scene,
    camera,
    controls,
    sun,
    water,
    field,
    bindScreen: water.bindScreen,
    update(elapsedSeconds) {
      island.update(elapsedSeconds, sun.color, sunDirection.copy(sun.position).sub(sun.target.position).normalize());
      water.update(elapsedSeconds);
      updateFoliageSun(sun);
      for (const palm of palms) palm.update(elapsedSeconds);
      for (const shrub of shrubs) shrub.update(elapsedSeconds);
    },
  };
}

/**
 * Foliage is Static for the tracer — it occludes and bounces — but its vertices move
 * in the wind, so its shadow is re-rendered each frame and it opts out of the atlas
 * (`userData.lightmap === false`, set by the entity). Trunks and stems stay baked.
 */
function tagFoliage(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    applyMobility(mesh, Mobility.Static, { animatesVertices: mesh.userData.animatesVertices === true });
  });
}
