import * as THREE from 'three/webgpu';
import { positionLocal, sin, uniform, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createNoise, seededRandom } from '../../shared/lib/noise.ts';
import { installVertexMotion } from '../../shared/render/vertexMotion.ts';
import { buildLeafRamp, veinTint, type LeafBiochemistry, type LeafRamp } from '../foliage/leafOptics.ts';
import { createLeafMaterial } from '../foliage/leafMaterial.ts';
import { buildLeafSurface, type LeafSurface } from '../foliage/leafSurface.ts';
import { NeedleBuilder, appendShoot } from './needleSpray.ts';

export interface ConiferOptions {
  seed: number;
  height: number;
  environment?: THREE.Texture;
  barkMaterial: THREE.Material;
}

export interface Conifer {
  group: THREE.Group;
  needleCount: number;
  update(timeSec: number): void;
}

const NEEDLE_MATURE: LeafBiochemistry = { N: 2.5, Cab: 48, Car: 13, Cbrown: 0.05 };
const NEEDLE_TIP: LeafBiochemistry = { N: 2.1, Cab: 30, Car: 10, Cbrown: 0 };

const WHORL_SPACING_METRES = 0.42;
const BRANCHES_PER_WHORL = 6;
const TWIGS_PER_BRANCH = 14;
const SHOOTS_PER_TWIG = 3;
const NEEDLE_PAIRS = 8;
const NEEDLE_LENGTH_METRES = 0.022;
const NEEDLE_WIDTH_METRES = 0.0018;
const SHOOT_LENGTH_METRES = 0.075;
const CROWN_BASE_FRACTION = 0.18;
const TRUNK_RADIUS_FRACTION = 0.016;

let needleSurface: LeafSurface | null = null;

function surface(): LeafSurface {
  if (!needleSurface) {
    needleSurface = buildLeafSurface({ venation: 'parallel', width: 0.02, length: 0.3, noise: createNoise(9021) });
  }
  return needleSurface;
}

interface BranchSpec {
  attach: THREE.Vector3;
  azimuth: number;
  droop: number;
  length: number;
  ramp: LeafRamp;
  random: () => number;
}

function branchAxis(spec: BranchSpec, t: number, out: THREE.Vector3): THREE.Vector3 {
  const sag = spec.droop * t * t;
  return out.set(
    spec.attach.x + Math.cos(spec.azimuth) * spec.length * t,
    spec.attach.y - sag * spec.length,
    spec.attach.z + Math.sin(spec.azimuth) * spec.length * t,
  );
}

function appendTwig(builder: NeedleBuilder, spec: BranchSpec, origin: THREE.Vector3, direction: THREE.Vector3, length: number): void {
  const up = new THREE.Vector3(0, 1, 0);
  const point = new THREE.Vector3();
  for (let i = 0; i < SHOOTS_PER_TWIG; i++) {
    const t = (i + 0.5) / SHOOTS_PER_TWIG;
    point.copy(origin).addScaledVector(direction, t * length);
    point.y -= 0.12 * length * t * t;
    appendShoot(builder, {
      origin: point.clone(),
      forward: direction.clone(),
      up: up.clone(),
      length: SHOOT_LENGTH_METRES,
      needleLength: NEEDLE_LENGTH_METRES * (0.85 + spec.random() * 0.3),
      needleWidth: NEEDLE_WIDTH_METRES,
      pairs: NEEDLE_PAIRS,
      ramp: spec.ramp,
      spread: 0.6 + spec.random() * 0.5,
    });
  }
}

function appendBranch(builder: NeedleBuilder, spec: BranchSpec): void {
  const up = new THREE.Vector3(0, 1, 0);
  const point = new THREE.Vector3();
  const next = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const twigDirection = new THREE.Vector3();
  for (let i = 0; i < TWIGS_PER_BRANCH; i++) {
    const t = 0.14 + 0.86 * ((i + 0.5) / TWIGS_PER_BRANCH);
    branchAxis(spec, t, point);
    branchAxis(spec, Math.min(1, t + 0.06), next);
    forward.copy(next).sub(point).normalize();
    const side = i % 2 === 0 ? 1 : -1;
    const swing = side * (0.55 + spec.random() * 0.35);
    twigDirection.copy(forward).applyAxisAngle(up, swing);
    twigDirection.y -= 0.12 + spec.random() * 0.1;
    twigDirection.normalize();
    const twigLength = spec.length * (0.34 - 0.24 * t) * (0.8 + spec.random() * 0.5);
    appendTwig(builder, spec, point.clone(), twigDirection, twigLength);
    appendTwig(builder, spec, point.clone(), forward.clone(), twigLength * 0.5);
  }
}

function buildTrunk(height: number, radius: number): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(radius * 0.35, radius, height, 14, 6, true);
  trunk.translate(0, height * 0.5, 0);
  const uv = trunk.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2.4, uv.getY(i) * height * 0.55);
  return trunk;
}

function buildCrown(options: ConiferOptions): { geometry: THREE.BufferGeometry; needles: number } {
  const random = seededRandom(options.seed);
  const ramp = buildLeafRamp(NEEDLE_MATURE, NEEDLE_TIP, 8);
  const builder = new NeedleBuilder();
  const base = options.height * CROWN_BASE_FRACTION;
  const top = options.height * 0.98;
  const whorls = Math.max(6, Math.round((top - base) / WHORL_SPACING_METRES));
  for (let whorl = 0; whorl < whorls; whorl++) {
    const t = whorl / (whorls - 1);
    const y = base + (top - base) * t;
    const reach = options.height * (0.26 - 0.24 * t) * (0.85 + random() * 0.3);
    const branches = Math.max(3, Math.round(BRANCHES_PER_WHORL * (1 - 0.4 * t)));
    for (let branch = 0; branch < branches; branch++) {
      appendBranch(builder, {
        attach: new THREE.Vector3(0, y, 0),
        azimuth: (branch / branches) * Math.PI * 2 + whorl * 1.1 + random() * 0.4,
        droop: 0.18 + 0.3 * (1 - t) + random() * 0.08,
        length: reach,
        ramp,
        random,
      });
    }
  }
  return { geometry: builder.build(), needles: builder.needleCount };
}

export function createConifer(options: ConiferOptions): Conifer {
  const random = seededRandom(options.seed + 977);
  const radius = options.height * TRUNK_RADIUS_FRACTION;
  const trunk = new THREE.Mesh(buildTrunk(options.height, radius), options.barkMaterial);
  trunk.name = 'coniferTrunk';
  trunk.castShadow = true;
  trunk.receiveShadow = true;

  const crown = buildCrown(options);
  const geometry = mergeGeometries([crown.geometry], false) ?? crown.geometry;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const windTime = uniform(0);
  const windTimePrev = uniform(0);
  const material = createLeafMaterial({
    surface: surface(),
    ior: 1.44,
    meanReflectance: [0.055, 0.11, 0.035],
    meanTransmittance: 0.06,
    veinTint: veinTint(NEEDLE_MATURE),
    environment: options.environment,
    name: 'conifer-needle',
  });
  const height = positionLocal.y;
  const phase = positionLocal.x.mul(1.7).add(positionLocal.z.mul(2.1));
  installVertexMotion(
    material,
    (t) => {
      const swayA = sin(t.mul(0.9).add(phase)).mul(height).mul(0.006);
      const swayB = sin(t.mul(1.7).add(phase.mul(1.3)).add(2.1)).mul(height).mul(0.004);
      return vec3(swayA, swayB.mul(0.3), swayB);
    },
    windTime,
    windTimePrev,
  );

  const needles = new THREE.Mesh(geometry, material);
  needles.name = 'coniferNeedles';
  needles.castShadow = true;
  needles.receiveShadow = true;
  needles.userData.animatesVertices = true;
  needles.userData.lightmap = false;

  const group = new THREE.Group();
  group.name = `conifer-${options.seed}`;
  group.add(trunk, needles);
  group.rotation.y = random() * Math.PI * 2;

  return {
    group,
    needleCount: crown.needles,
    update(timeSec: number): void {
      windTimePrev.value = windTime.value;
      windTime.value = timeSec;
    },
  };
}
