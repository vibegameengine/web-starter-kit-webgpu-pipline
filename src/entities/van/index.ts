import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface VanPlacement {
  x: number;
  z: number;
  headingRadiansFromNoseTowardPositiveZ: number;
  scale?: number;
  ground: (x: number, z: number) => number;
  doors?: number | Partial<Record<DoorId, number>>;
}

export type DoorId = 'frontLeft' | 'frontRight' | 'slideLeft' | 'slideRight' | 'tailgate';

export const DOOR_IDS: DoorId[] = ['frontLeft', 'frontRight', 'slideLeft', 'slideRight', 'tailgate'];

const DOOR_CODES: Record<string, DoorId> = {
  fl: 'frontLeft',
  fr: 'frontRight',
  sl: 'slideLeft',
  sr: 'slideRight',
  tg: 'tailgate',
};

export function parseDoors(raw: string | null): number | Partial<Record<DoorId, number>> {
  if (!raw) return 0;
  if (!raw.includes(':')) return Number(raw) || 0;
  const out: Partial<Record<DoorId, number>> = {};
  for (const entry of raw.split(',')) {
    const [code, value] = entry.split(':');
    const id = DOOR_CODES[code.trim()];
    if (id) out[id] = Number(value) || 0;
  }
  return out;
}

export interface Van {
  group: THREE.Group;
  setDoor: (id: DoorId, amount: number) => void;
  setDoors: (amount: number) => void;
  poses: () => Record<string, { side: number; x: number; y: number; z: number; ry: number; rx: number }>;
  contact: { y: number; pitch: number; roll: number; travel: number[] };
}

const FRONT_AXLE_Z = 1.24;
const REAR_AXLE_Z = -1.505;
const HALF_TRACK = 0.82;
const TYRE_RADIUS = 0.42;
const SINK = 0.02;
const SUSPENSION_TRAVEL_METRES = 0.09;
/* @important The Tripo body sat on its tyres with no arch gap; the shell, glass and
   doors ride 75 mm above the wheels, which stay on the sand. */
const BODY_LIFT_METRES = 0.075;
const SWING_RADIANS = 0.96;
const SLIDE_BACK_METRES = 1.05;
const SLIDE_OUT_METRES = 0.115;
const SLIDE_OUT_FRACTION = 0.25;
const LIFT_RADIANS = 1.05;

const CONTACTS: Array<[number, number]> = [
  [-HALF_TRACK, FRONT_AXLE_Z],
  [HALF_TRACK, FRONT_AXLE_Z],
  [-HALF_TRACK, REAR_AXLE_Z],
  [HALF_TRACK, REAR_AXLE_Z],
];

interface Door {
  id: DoorId;
  node: THREE.Object3D;
  rest: THREE.Vector3;
  kind: 'swing' | 'slide' | 'lift';
  side: number;
}

/* @important GLTFLoader sanitises node names: 'DOOR | front left' arrives as
   'DOOR___front_left', so matching the authored string with spaces found nothing and
   only the single-word tailgate was ever driven. Match on words. */
const DOOR_BY_WORDS: Array<[string[], DoorId]> = [
  [['front', 'left'], 'frontLeft'],
  [['front', 'right'], 'frontRight'],
  [['slide', 'left'], 'slideLeft'],
  [['slide', 'right'], 'slideRight'],
  [['tailgate'], 'tailgate'],
];

function doorIdOf(name: string): DoorId | null {
  const words = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (!words.includes('door')) return null;
  const match = DOOR_BY_WORDS.find(([needed]) => needed.every((word) => words.includes(word)));
  return match ? match[1] : null;
}

function toWorld(placement: VanPlacement, scale: number, lx: number, lz: number): [number, number] {
  const cos = Math.cos(placement.headingRadiansFromNoseTowardPositiveZ);
  const sin = Math.sin(placement.headingRadiansFromNoseTowardPositiveZ);
  return [
    placement.x + (lx * cos + lz * sin) * scale,
    placement.z + (-lx * sin + lz * cos) * scale,
  ];
}

function groundUnderWheels(placement: VanPlacement, scale: number): number[] {
  return CONTACTS.map(([lx, lz]) => placement.ground(...toWorld(placement, scale, lx, lz)));
}

/* @important The hinge translation sits on the glTF node and the mesh under it is at
   the origin, so node.position.x is 0 for every door: deriving the side from it made
   them all +1 and drove the right-hand slider into the cabin. */
function doorSide(node: THREE.Object3D, body: THREE.Object3D): number {
  const centre = new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3());
  return Math.sign(body.worldToLocal(centre).x) || 1;
}

function liftBody(root: THREE.Object3D): void {
  for (const node of root.children) {
    if (node.name.toLowerCase().includes('wheel')) continue;
    node.position.y += BODY_LIFT_METRES;
  }
}

function collectDoors(root: THREE.Object3D, body: THREE.Object3D): Door[] {
  const doors: Door[] = [];
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    const id = doorIdOf(node.name);
    if (!id) return;
    const kind = id.startsWith('slide') ? 'slide' : id === 'tailgate' ? 'lift' : 'swing';
    doors.push({ id, node, rest: node.position.clone(), kind, side: doorSide(node, body) });
  });
  return doors;
}

function openDoor(door: Door, amount: number): void {
  const { node, rest, kind, side } = door;
  node.position.copy(rest);
  node.rotation.set(0, 0, 0);
  if (kind === 'swing') node.rotation.y = -side * SWING_RADIANS * amount;
  else if (kind === 'lift') node.rotation.x = LIFT_RADIANS * amount;
  else {
    /* @important A real slider leaves the aperture before it runs back; moving it
       straight back drives the leaf through the rear quarter panel. */
    const out = Math.min(1, amount / SLIDE_OUT_FRACTION);
    const back = Math.max(0, (amount - SLIDE_OUT_FRACTION) / (1 - SLIDE_OUT_FRACTION));
    node.position.x = rest.x + side * SLIDE_OUT_METRES * out;
    node.position.z = rest.z - SLIDE_BACK_METRES * back;
  }
}

function settleWheels(root: THREE.Object3D, placement: VanPlacement, scale: number): number[] {
  const travel: number[] = [];
  root.updateMatrixWorld(true);
  const world = new THREE.Vector3();
  root.traverse((node) => {
    if (!node.name.startsWith('WHEEL')) return;
    world.setFromMatrixPosition(node.matrixWorld);
    const ground = placement.ground(world.x, world.z);
    const drop = ground - (world.y - TYRE_RADIUS * scale);
    const clamped = THREE.MathUtils.clamp(drop, -SUSPENSION_TRAVEL_METRES, SUSPENSION_TRAVEL_METRES);
    node.position.y += clamped / scale;
    travel.push(clamped);
  });
  root.updateMatrixWorld(true);
  return travel;
}

export async function createVan(placement: VanPlacement): Promise<Van> {
  const scale = placement.scale ?? 1;
  const url = `${import.meta.env.BASE_URL}models/nomad/nomad-van.glb`;
  const gltf = await new GLTFLoader().loadAsync(url);
  const group = new THREE.Group();
  group.name = 'van';
  group.add(gltf.scene);
  gltf.scene.scale.setScalar(scale);
  liftBody(gltf.scene);

  const [frontLeft, frontRight, rearLeft, rearRight] = groundUnderWheels(placement, scale);
  const front = (frontLeft + frontRight) * 0.5;
  const rear = (rearLeft + rearRight) * 0.5;
  const left = (frontLeft + rearLeft) * 0.5;
  const right = (frontRight + rearRight) * 0.5;
  const pitch = Math.atan2(front - rear, (FRONT_AXLE_Z - REAR_AXLE_Z) * scale);
  const roll = Math.atan2(right - left, 2 * HALF_TRACK * scale);

  group.position.set(placement.x, (front + rear) * 0.5 - SINK, placement.z);
  group.rotation.set(0, placement.headingRadiansFromNoseTowardPositiveZ, 0, 'YXZ');
  gltf.scene.rotation.set(-pitch, 0, roll, 'ZXY');

  prepareSurfaces(group);
  const doors = collectDoors(group, gltf.scene);
  const setDoor = (id: DoorId, amount: number) => {
    const door = doors.find((entry) => entry.id === id);
    if (door) openDoor(door, amount);
  };
  const setDoors = (amount: number) => doors.forEach((door) => openDoor(door, amount));
  const poses = () => Object.fromEntries(doors.map((door) => [door.id, {
    side: door.side,
    x: +door.node.position.x.toFixed(3),
    y: +door.node.position.y.toFixed(3),
    z: +door.node.position.z.toFixed(3),
    ry: +door.node.rotation.y.toFixed(3),
    rx: +door.node.rotation.x.toFixed(3),
  }]));
  applyInitial(doors, placement.doors ?? 0);
  const travel = settleWheels(group, placement, scale);

  return { group, setDoor, setDoors, poses, contact: { y: group.position.y, pitch, roll, travel } };
}

function applyInitial(doors: Door[], amount: number | Partial<Record<DoorId, number>>): void {
  for (const door of doors) {
    openDoor(door, typeof amount === 'number' ? amount : amount[door.id] ?? 0);
  }
}

function prepareSurfaces(group: THREE.Group): void {
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    /* @important Projected charts in the 512 px atlas came back visibly blotchy on the
       curved panels (shots/van/_compare_body.png); live surfels are clean. */
    mesh.userData.lightmap = false;
    /* @important Glass is opaque to the tracer, which walls the cabin off from the sky.
       `?vanGlassGi=1` is the ablation. */
    if (mesh.name.includes('glass') && !new URLSearchParams(window.location.search).get('vanGlassGi')) {
      mesh.userData.giExclude = true;
    }
    // @important The body has no UVs and the raster node graph still reads `uv`.
    if (!mesh.geometry.getAttribute('uv')) {
      const count = mesh.geometry.getAttribute('position').count;
      mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    for (const entry of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const material = entry as THREE.Material;
      /* @important One skin, no inner panels: an open door shows back faces, and
         single-sided shading turned every opening into a black hole. */
      material.side = THREE.DoubleSide;
      // @important Transparent glazing must not write depth over the interior.
      if (material.transparent) material.depthWrite = false;
    }
  });
}
