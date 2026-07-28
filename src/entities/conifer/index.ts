import * as THREE from 'three';
import { makeBark, makeNeedleCard } from '../../shared/lib/organicTextures';
import type { HeightFog } from '../../shared/engine/heightFog';

/**
 * Conifer generator. A tree is a tapered, slightly bent trunk plus a canopy
 * of alpha-tested branch cards arranged in drooping whorls (spruce/redwood
 * habit). Variants are merged geometries used by InstancedMesh; heroes are
 * larger one-off meshes for the near field.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ConiferOpts {
  height: number;
  baseRadius: number;
  /** fraction of height where the live crown starts */
  crownStart: number;
  whorls: number;
  branchesPerWhorl: number;
  maxBranchLen: number;
  droop: number; // radians downward
  trunkSegments: number;
}

const DEFAULTS: ConiferOpts = {
  height: 34,
  baseRadius: 0.55,
  crownStart: 0.18,
  whorls: 15,
  branchesPerWhorl: 8,
  maxBranchLen: 5.4,
  droop: 0.42,
  trunkSegments: 8,
};

export interface ConiferGeometry {
  trunk: THREE.BufferGeometry;
  canopy: THREE.BufferGeometry;
  height: number;
}

export function buildConifer(seed: number, opts: Partial<ConiferOpts> = {}): ConiferGeometry {
  const o = { ...DEFAULTS, ...opts };
  const rand = mulberry32(seed);

  // ── trunk: tapered cylinder with a gentle lean ────────────────────────────
  const trunk = new THREE.CylinderGeometry(
    o.baseRadius * 0.16, o.baseRadius, o.height, o.trunkSegments, 8, false,
  );
  trunk.translate(0, o.height / 2, 0);
  {
    const pos = trunk.attributes.position as THREE.BufferAttribute;
    const leanX = (rand() - 0.5) * 0.03;
    const leanZ = (rand() - 0.5) * 0.03;
    const wobble = 0.35 + rand() * 0.5;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const t = y / o.height;
      pos.setX(i, pos.getX(i) + leanX * y * y * 0.06 + Math.sin(t * 5.1 + seed) * wobble * t);
      pos.setZ(i, pos.getZ(i) + leanZ * y * y * 0.06 + Math.cos(t * 4.3 + seed) * wobble * t);
    }
    trunk.computeVertexNormals();
    // scale bark UVs: around ~1 wrap per circumference, repeat vertically
    const uv = trunk.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * (o.height / 6));
    }
  }

  // ── canopy: whorls of drooping cards ──────────────────────────────────────
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let vi = 0;

  const card = (
    origin: THREE.Vector3, yaw: number, pitch: number, roll: number,
    len: number, wid: number, shade: number,
  ) => {
    // card plane: extends +Z from origin, width along X
    const m = new THREE.Matrix4()
      .makeRotationFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'))
      .setPosition(origin);
    const n = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
    const corners = [
      new THREE.Vector3(-wid / 2, 0, 0),
      new THREE.Vector3(wid / 2, 0, 0),
      new THREE.Vector3(-wid / 2, 0, len),
      new THREE.Vector3(wid / 2, 0, len),
    ];
    for (const cnr of corners) {
      cnr.applyMatrix4(m);
      positions.push(cnr.x, cnr.y, cnr.z);
      normals.push(n.x, n.y, n.z);
      colors.push(shade, shade, shade);
    }
    // texture: twig grows from bottom of canvas (v=0 at origin edge)
    uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
    indices.push(vi, vi + 1, vi + 2, vi + 2, vi + 1, vi + 3);
    vi += 4;
  };

  const crownBase = o.height * o.crownStart;
  const crownLen = o.height - crownBase;
  for (let w = 0; w < o.whorls; w++) {
    const t = w / (o.whorls - 1);
    const y = crownBase + crownLen * t;
    const reach = o.maxBranchLen * (1 - t * 0.82) * (0.85 + rand() * 0.3);
    const droop = o.droop * (1 - t * 0.5);
    const yawOff = rand() * Math.PI * 2;
    const count = Math.max(3, Math.round(o.branchesPerWhorl * (1 - t * 0.35)));
    for (let b = 0; b < count; b++) {
      const yaw = yawOff + (b / count) * Math.PI * 2 + (rand() - 0.5) * 0.5;
      const jitterY = (rand() - 0.5) * crownLen / o.whorls * 0.8;
      const origin = new THREE.Vector3(
        Math.sin(yaw) * o.baseRadius * 0.4,
        y + jitterY,
        Math.cos(yaw) * o.baseRadius * 0.4,
      );
      // inner-canopy shade: deeper cards darker (fake self-occlusion)
      const shade = 0.28 + 0.72 * Math.min(1, t * 0.55 + 0.22 + (rand() - 0.5) * 0.25);
      // three cards per branch: one flat + two steep rolls — the fan stays
      // visible from eye level, not just from above
      card(origin, yaw, droop, (rand() - 0.5) * 0.4, reach, reach * 0.8, shade);
      card(origin, yaw, droop, 1.0 + rand() * 0.35, reach, reach * 0.7, shade * 0.9);
      card(origin, yaw, droop, -1.0 - rand() * 0.35, reach, reach * 0.7, shade * 0.85);
    }
  }
  // crown tip: small vertical cards
  for (let i = 0; i < 3; i++) {
    const yaw = (i / 3) * Math.PI * 2;
    card(
      new THREE.Vector3(0, o.height - o.maxBranchLen * 0.55, 0),
      yaw, -1.25, 0, o.maxBranchLen * 0.6, o.maxBranchLen * 0.35, 0.95,
    );
  }

  const canopy = new THREE.BufferGeometry();
  canopy.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  canopy.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  canopy.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  canopy.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  canopy.setIndex(indices);

  return { trunk, canopy, height: o.height };
}

// ── materials (shared) ───────────────────────────────────────────────────────
export function makeConiferMaterials(
  fog: HeightFog,
  tone: 'redwood' | 'pine' = 'redwood',
  sss?: { dir: THREE.Vector3; color: THREE.Color },
) {
  const sssSunDir = { value: sss?.dir ?? new THREE.Vector3(0, 1, 0) };
  const sssColor = { value: sss?.color ?? new THREE.Color(1.0, 0.85, 0.55) };
  const bark = makeBark(tone === 'redwood' ? 3 : 5, tone);
  const needles = makeNeedleCard(7);

  const trunkMat = new THREE.MeshStandardMaterial({
    map: bark.map,
    normalMap: bark.normalMap,
    normalScale: new THREE.Vector2(1.2, 1.2),
    roughness: 0.94,
    metalness: 0,
  });
  fog.patch(trunkMat);

  const canopyMat = new THREE.MeshStandardMaterial({
    map: needles,
    alphaTest: 0.34,
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0,
    vertexColors: true,
  });
  canopyMat.envMapIntensity = 0.35;
  // fake subsurface: needles glow warm when the sun is behind them
  const prevCompile = canopyMat.onBeforeCompile;
  canopyMat.onBeforeCompile = (shader, renderer) => {
    prevCompile?.call(canopyMat, shader, renderer);
    shader.uniforms.uSssSunDir = sssSunDir;
    shader.uniforms.uSssColor = sssColor;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uSssSunDir; uniform vec3 uSssColor;`)
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        {
          vec3 V = normalize( cameraPosition - vHFWorldPos );
          float backlit = pow( clamp( dot( -V, uSssSunDir ), 0.0, 1.0 ), 6.0 );
          reflectedLight.indirectDiffuse += diffuseColor.rgb * uSssColor * backlit * 0.5;
        }`,
      );
  };
  fog.patch(canopyMat);
  canopyMat.customProgramCacheKey = () => 'heightfog-sss';

  return { trunkMat, canopyMat };
}

// ── forest scatter ───────────────────────────────────────────────────────────
export interface ScatterOpts {
  count: number;
  radius: number;
  minDist: number;
  /** keep this cone (toward -Z from origin) clear for the vista */
  corridorHalfAngle: number;
  corridorMinDist: number;
  heightAt: (x: number, z: number) => number;
  exclude?: (x: number, z: number) => boolean;
  seed?: number;
}

export function scatterForest(
  variants: ConiferGeometry[],
  materials: { trunkMat: THREE.Material; canopyMat: THREE.Material },
  opts: ScatterOpts,
): THREE.Group {
  const rand = mulberry32(opts.seed ?? 99);
  const placed: [number, number][] = [];
  const perVariant: THREE.Matrix4[][] = variants.map(() => []);

  let attempts = 0;
  while (placed.length < opts.count && attempts < opts.count * 40) {
    attempts++;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * opts.radius;
    const x = Math.sin(a) * r;
    const z = Math.cos(a) * r;

    // vista corridor: a wedge toward -Z stays clear
    const angFromMinusZ = Math.abs(Math.atan2(x, -z));
    if (z < 0 && angFromMinusZ < opts.corridorHalfAngle && Math.hypot(x, z) > opts.corridorMinDist) continue;
    if (opts.exclude?.(x, z)) continue;

    let ok = true;
    for (const [px, pz] of placed) {
      if ((px - x) ** 2 + (pz - z) ** 2 < opts.minDist * opts.minDist) { ok = false; break; }
    }
    if (!ok) continue;

    placed.push([x, z]);
    const y = opts.heightAt(x, z);
    const scale = 0.72 + rand() * 0.62;
    const m = new THREE.Matrix4()
      .makeRotationY(rand() * Math.PI * 2)
      .premultiply(new THREE.Matrix4().makeScale(scale, scale * (0.9 + rand() * 0.25), scale))
      .setPosition(x, y - 0.4, z);
    perVariant[Math.floor(rand() * variants.length)].push(m);
  }

  const group = new THREE.Group();
  variants.forEach((v, i) => {
    const mats = perVariant[i];
    if (!mats.length) return;
    const trunkIM = new THREE.InstancedMesh(v.trunk, materials.trunkMat, mats.length);
    const canopyIM = new THREE.InstancedMesh(v.canopy, materials.canopyMat, mats.length);
    const tint = new THREE.Color();
    mats.forEach((m, j) => {
      trunkIM.setMatrixAt(j, m);
      canopyIM.setMatrixAt(j, m);
      tint.setHSL(0.26 + rand() * 0.09, 0.32 + rand() * 0.25, 0.32 + rand() * 0.16);
      canopyIM.setColorAt(j, tint);
    });
    trunkIM.castShadow = trunkIM.receiveShadow = true;
    canopyIM.castShadow = true;
    canopyIM.receiveShadow = false;
    group.add(trunkIM, canopyIM);
  });
  return group;
}
