import * as THREE from 'three/webgpu';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { createScene } from '../../shared/gi/surfel/scene.ts';
import { Mobility, applyMobility, Layer } from '../../shared/world/index.ts';
import { GroveField, createGrove } from '../../entities/grove/index.ts';
import { createStreamMaterial, type StreamMaterial } from '../../entities/grove/streamMaterial.ts';
import { createDressedBoulderMaterial, type ForestMaps } from '../../entities/grove/dressedMaterials.ts';
import {
  createBlockoutMaterials,
  createBoulder,
  createFallenLog,
} from '../../entities/grove/blockoutProps.ts';
import { cloneEzPlant, createEzPine, type EzPine, type EzPreset } from '../../entities/conifer/ezPine.ts';
import { seededRandom } from '../../shared/lib/noise.ts';
import { createBackdrop } from '../../entities/backdrop/index.ts';
import type { VolumetricFogSettings } from '../../shared/render/index.ts';

export interface ForestScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sun: THREE.DirectionalLight;
  field: GroveField;
  update: (elapsedSeconds: number) => void;
  atmosphere: Partial<VolumetricFogSettings>;
  glare: { strength: number; radius: number };
}

const CAMERA_PRESETS: Record<string, [THREE.Vector3, THREE.Vector3]> = {
  hero: [new THREE.Vector3(-17.0, 12.0, 20.5), new THREE.Vector3(0.0, 0.4, -0.6)],
  wide: [new THREE.Vector3(-16.0, 12.5, 19.0), new THREE.Vector3(0.0, 1.0, -0.8)],
  trail: [new THREE.Vector3(3.4, 2.0, 5.4), new THREE.Vector3(1.6, 0.6, -1.8)],
  stream: [new THREE.Vector3(-0.6, 2.2, 3.0), new THREE.Vector3(-3.0, 0.5, -1.6)],
  ledge: [new THREE.Vector3(0.4, 1.8, -0.4), new THREE.Vector3(-3.4, 0.6, -2.6)],
  canopy: [new THREE.Vector3(1.6, 2.4, 5.0), new THREE.Vector3(3.0, 6.5, -2.0)],
  rim: [new THREE.Vector3(-8.0, 1.0, 9.0), new THREE.Vector3(-1.0, -0.4, 0.5)],
};

const SPRUCES = [
  { x: 4.4, z: -2.2, height: 9.0, seed: 11 },
  { x: 3.2, z: -5.0, height: 7.6, seed: 12 },
  { x: -4.6, z: -4.6, height: 4.6, seed: 15 },
  { x: -3.0, z: -5.6, height: 3.4, seed: 16 },
];

const BOULDERS = [
  { x: -3.0, z: -2.2, radius: 0.85, seed: 61, mossy: true },
  { x: -2.3, z: -0.2, radius: 0.6, seed: 62, mossy: true },
  { x: -3.6, z: 1.4, radius: 0.7, seed: 63, mossy: true },
  { x: -1.9, z: 2.8, radius: 0.5, seed: 64 },
  { x: -4.6, z: -0.6, radius: 0.55, seed: 65, mossy: true },
  { x: -2.6, z: 4.4, radius: 0.65, seed: 66, mossy: true },
  { x: 4.8, z: 1.2, radius: 0.5, seed: 67, mossy: true },
  { x: 0.2, z: 3.6, radius: 0.42, seed: 68 },
];

const BACKGROUND_PINES = [
  { x: 0.6, z: -6.0, height: 8.4, seed: 33 },
  { x: 5.9, z: -4.6, height: 7.0, seed: 34 },
];

const DISTANT_TEMPLATE_HEIGHT = 12;
const DISTANT_STAND_COUNT = 26;
const DISTANT_STAND_NEAR = 30.0;
const DISTANT_STAND_FAR = 75.0;
const DISTANT_STAND_SINK = 0.4;
const DISTANT_STAND_BEARING = -0.89;
const DISTANT_STAND_SPREAD = 0.42;

const SCATTER_COUNT = 90;
const SCATTER_MIN_HEIGHT = 0.25;
const SCATTER_MAX_HEIGHT = 0.85;

const FERNS = [
  { x: -0.9, z: -1.6, radius: 0.38, seed: 81 },
  { x: 0.4, z: 0.6, radius: 0.32, seed: 82 },
  { x: -1.4, z: 1.8, radius: 0.35, seed: 83 },
  { x: 3.6, z: -0.4, radius: 0.3, seed: 84 },
  { x: 4.6, z: -3.8, radius: 0.36, seed: 85 },
  { x: 2.6, z: 2.4, radius: 0.28, seed: 86 },
  { x: -4.8, z: 3.0, radius: 0.34, seed: 87 },
  { x: 0.8, z: -4.2, radius: 0.4, seed: 88 },
];

async function loadForestMaps(): Promise<ForestMaps> {
  const base = import.meta.env.BASE_URL;
  const loader = new THREE.TextureLoader();
  const load = async (name: string, srgb: boolean) => {
    const map = await loader.loadAsync(`${base}textures/forest/${name}`);
    map.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.anisotropy = 8;
    return map;
  };
  const [mossColor, mossNormal, mossRoughness, floorColor, floorNormal, floorRoughness, graniteColor, graniteNormal, graniteRoughness] =
    await Promise.all([
      load('moss_color.jpg', true),
      load('moss_normal.jpg', false),
      load('moss_roughness.jpg', false),
      load('floor_color.jpg', true),
      load('floor_normal.jpg', false),
      load('floor_roughness.jpg', false),
      load('granite_color.jpg', true),
      load('granite_normal.jpg', false),
      load('granite_roughness.jpg', false),
    ]);
  return { mossColor, mossNormal, mossRoughness, floorColor, floorNormal, floorRoughness, graniteColor, graniteNormal, graniteRoughness };
}

function placeCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, search: URLSearchParams): void {
  camera.fov = 30;
  camera.near = 0.2;
  camera.far = 600;
  camera.updateProjectionMatrix();
  const preset = CAMERA_PRESETS[search.get('cam') ?? 'hero'] ?? CAMERA_PRESETS.hero;
  camera.position.copy(preset[0]);
  controls.target.copy(preset[1]);
  const triple = (key: string) => {
    const raw = search.get(key)?.split(',').map(Number);
    return raw?.length === 3 && raw.every(Number.isFinite) ? new THREE.Vector3(raw[0], raw[1], raw[2]) : null;
  };
  const free = triple('camPos');
  if (free) {
    camera.position.copy(free);
    controls.target.copy(triple('camTarget') ?? new THREE.Vector3(0, 0, 0));
  }
  controls.update();
  camera.layers.enable(Layer.Debug);
}

function buildStreamRibbon(field: GroveField, stream: StreamMaterial, samples = 128): THREE.Mesh {
  const positions: number[] = [];
  const halfWidth = field.streamHalfWidth * 1.15;
  const surface = (p: THREE.Vector2) => field.streamSurface(p.x, p.y);
  const rim = field.half - 0.7;
  for (let i = 0; i < samples; i++) {
    const a = field.streamCentre(i / samples);
    const b = field.streamCentre((i + 1) / samples);
    if (Math.abs(a.y) > rim || Math.abs(b.y) > rim || Math.abs(a.x) > rim || Math.abs(b.x) > rim) continue;
    const direction = b.clone().sub(a).normalize();
    const side = new THREE.Vector2(-direction.y, direction.x).multiplyScalar(halfWidth);
    const aL = a.clone().sub(side);
    const aR = a.clone().add(side);
    const bL = b.clone().sub(side);
    const bR = b.clone().add(side);
    positions.push(aL.x, surface(aL), aL.y, bL.x, surface(bL), bL.y, aR.x, surface(aR), aR.y);
    positions.push(aR.x, surface(aR), aR.y, bL.x, surface(bL), bL.y, bR.x, surface(bR), bR.y);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, stream.material);
  mesh.name = 'groveStream';
  mesh.receiveShadow = true;
  return mesh;
}

function distantStand(variants: EzPine[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'distantStand';
  const random = seededRandom(9091);
  for (let i = 0; i < DISTANT_STAND_COUNT; i++) {
    const angle = DISTANT_STAND_BEARING + (random() * 2 - 1) * DISTANT_STAND_SPREAD;
    const distance = DISTANT_STAND_NEAR + random() * (DISTANT_STAND_FAR - DISTANT_STAND_NEAR);
    const height = 11 + random() * 10;
    const plant = cloneEzPlant(variants[i % variants.length]);
    plant.scale.setScalar(height / DISTANT_TEMPLATE_HEIGHT);
    plant.position.set(Math.cos(angle) * distance, -DISTANT_STAND_SINK - random() * 1.5, Math.sin(angle) * distance);
    plant.rotation.y = random() * Math.PI * 2;
    group.add(plant);
  }
  return group;
}

function scatterUndergrowth(field: GroveField, variants: EzPine[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'scatter';
  const random = seededRandom(7788);
  const reach = field.half - 0.5;
  for (let i = 0; i < SCATTER_COUNT; i++) {
    const x = (random() * 2 - 1) * reach;
    const z = (random() * 2 - 1) * reach;
    if (field.streamMask(x, z) > 0.12 || field.trailMask(x, z) > 0.35) continue;
    const plant = cloneEzPlant(variants[i % variants.length]);
    const scale = (SCATTER_MIN_HEIGHT + random() * (SCATTER_MAX_HEIGHT - SCATTER_MIN_HEIGHT)) / SCATTER_MAX_HEIGHT;
    plant.scale.setScalar(scale);
    plant.position.set(x, field.height(x, z) - 0.02, z);
    plant.rotation.y = random() * Math.PI * 2;
    group.add(plant);
  }
  return group;
}

function populate(scene: THREE.Scene, field: GroveField, maps: ForestMaps): void {
  const materials = createBlockoutMaterials();
  materials.rock = createDressedBoulderMaterial(maps, 'bare');
  materials.moss = createDressedBoulderMaterial(maps, 'mossy');
  const trees = new THREE.Group();
  trees.name = 'conifers';
  let treeTriangles = 0;
  for (const spec of [...SPRUCES, ...BACKGROUND_PINES]) {
    const preset = spec.height > 7 ? 'Pine Large' : spec.height > 5 ? 'Pine Medium' : 'Pine Small';
    const pine = createEzPine({ seed: spec.seed, height: spec.height, preset });
    pine.group.position.set(spec.x, field.height(spec.x, spec.z) - 0.05, spec.z);
    trees.add(pine.group);
    treeTriangles += pine.triangleCount;
  }
  console.info(`[forest] ${SPRUCES.length} pines, ${treeTriangles} tris`);

  const rocks = new THREE.Group();
  rocks.name = 'boulders';
  for (const spec of BOULDERS) rocks.add(createBoulder(spec, materials, field.height(spec.x, spec.z)));

  const undergrowth = new THREE.Group();
  undergrowth.name = 'undergrowth';
  const bushPresets: EzPreset[] = ['Bush 1', 'Bush 2', 'Bush 3'];
  const withBushes = new URLSearchParams(window.location.search).get('bushes') !== '0';
  for (const [index, spec] of (withBushes ? FERNS : []).entries()) {
    const bush = createEzPine({
      seed: spec.seed,
      height: spec.radius * 2.4,
      preset: bushPresets[index % bushPresets.length],
      bakeIntoLightmap: false,
    });
    bush.group.position.set(spec.x, field.height(spec.x, spec.z) - 0.02, spec.z);
    undergrowth.add(bush.group);
  }

  const distantVariants = ['Pine Large', 'Pine Medium'].map((preset, index) =>
    createEzPine({ seed: 900 + index, height: DISTANT_TEMPLATE_HEIGHT, preset: preset as EzPreset, bakeIntoLightmap: false }));
  const distant = distantStand(distantVariants);
  scene.add(distant);
  applyMobility(distant, Mobility.Static);

  const variants = ['Bush 1', 'Bush 2', 'Bush 3'].map((preset, index) =>
    createEzPine({ seed: 500 + index, height: SCATTER_MAX_HEIGHT, preset: preset as EzPreset, bakeIntoLightmap: false }));
  undergrowth.add(scatterUndergrowth(field, variants));

  const log = createFallenLog(2.2, 1.6, 3.2, 0.6, materials, field.height(2.2, 1.6));
  for (const object of [rocks, undergrowth, log]) {
    scene.add(object);
    applyMobility(object, Mobility.Static);
  }
  scene.add(trees);
  trees.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    applyMobility(mesh, Mobility.Static, { animatesVertices: mesh.userData.animatesVertices === true });
  });
}

export async function createForestScene(renderer: THREE.WebGPURenderer): Promise<ForestScene> {
  const { scene, camera, controls, dirLight: sun } = createScene(renderer);
  scene.background = null;
  placeCamera(camera, controls, new URLSearchParams(window.location.search));

  const maps = await loadForestMaps();
  const field = new GroveField(21, 6, -2.4);
  const grove = createGrove({ field, maps });
  scene.add(grove.group);
  applyMobility(grove.group, Mobility.Static);

  const stream = createStreamMaterial();
  const streamMesh = buildStreamRibbon(field, stream);
  scene.add(streamMesh);
  applyMobility(streamMesh, Mobility.Static);

  populate(scene, field, maps);

  const backdrop = createBackdrop({ islandBottom: field.bottom, islandHalf: field.half });
  scene.add(backdrop);
  backdrop.traverse((object) => {
    object.layers.set(Layer.Debug);
    object.userData.giExclude = true;
  });

  (window as unknown as Record<string, unknown>).__forest = {
    height: (x: number, z: number) => field.height(x, z),
    cover: (x: number, z: number) => field.cover(x, z),
    stream: (x: number, z: number) => field.streamSurface(x, z),
    triangles: grove.triangleCount,
    leaves: grove.leafCount,
  };

  return {
    scene,
    camera,
    controls,
    sun,
    field,
    atmosphere: forestMist(field),
    glare: { strength: 0.24, radius: 0.5 },
    update(elapsedSeconds: number) {
      stream.update(elapsedSeconds);
    },
  };
}

function forestMist(field: GroveField): Partial<VolumetricFogSettings> {
  return {
    enabled: true,
    density: 0.011,
    baseHeight: -1.6,
    heightFalloff: 0.3,
    center: new THREE.Vector3(0, 3.0, -6.0),
    halfExtents: new THREE.Vector3(field.half + 60, 18, field.half + 60),
    softness: 8,
    sunIntensity: 16,
    anisotropy: 0.82,
    ambientIntensity: 0.55,
    noiseStrength: 0.6,
    noiseScale: 0.22,
    windSpeed: 0.35,
    windDirection: 30,
    near: 9.0,
    far: 90,
  };
}
