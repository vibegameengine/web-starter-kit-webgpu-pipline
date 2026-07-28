import * as THREE from 'three';
import { makeFern } from '../../shared/lib/organicTextures';
import type { HeightFog } from '../../shared/engine/heightFog';

/**
 * Fern understory: each plant is a fan of bent frond cards; thousands of
 * instances carpet the forest floor (the single biggest "reference look"
 * ingredient after the trees themselves).
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

/** One fern: N fronds fanning out, each a 2-segment bent card. */
function buildFernGeometry(seed = 5, fronds = 8): THREE.BufferGeometry {
  const rand = mulberry32(seed);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let vi = 0;

  for (let f = 0; f < fronds; f++) {
    const yaw = (f / fronds) * Math.PI * 2 + (rand() - 0.5) * 0.6;
    const pitch0 = 0.9 + rand() * 0.5;         // initial rise from ground
    const len = 0.9 + rand() * 0.5;
    const wid = 0.34 + rand() * 0.18;
    const shade = 0.65 + rand() * 0.35;

    // 2-segment bent card: base → mid (steep), mid → tip (drooping)
    const dir0 = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch0), Math.sin(pitch0), Math.cos(yaw) * Math.cos(pitch0));
    const mid = dir0.clone().multiplyScalar(len * 0.55);
    const pitch1 = pitch0 - (0.8 + rand() * 0.5);
    const dir1 = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch1), Math.sin(pitch1), Math.cos(yaw) * Math.cos(pitch1));
    const tip = mid.clone().add(dir1.multiplyScalar(len * 0.45));

    const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)).multiplyScalar(wid / 2);
    const pts = [
      new THREE.Vector3().sub(side), new THREE.Vector3().add(side),
      mid.clone().sub(side), mid.clone().add(side),
      tip.clone().sub(side), tip.clone().add(side),
    ];
    const n = new THREE.Vector3(Math.sin(yaw), 0.8, Math.cos(yaw)).normalize();
    for (let i = 0; i < 6; i++) {
      positions.push(pts[i].x, pts[i].y, pts[i].z);
      normals.push(n.x, n.y, n.z);
      colors.push(shade, shade, shade);
    }
    uvs.push(0, 0, 1, 0, 0, 0.55, 1, 0.55, 0, 1, 1, 1);
    indices.push(vi, vi + 1, vi + 2, vi + 2, vi + 1, vi + 3, vi + 2, vi + 3, vi + 4, vi + 4, vi + 3, vi + 5);
    vi += 6;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  return geo;
}

export interface FernFieldOpts {
  count: number;
  radius: number;
  heightAt: (x: number, z: number) => number;
  /** density multiplier 0..1 given a position (patchiness) */
  density?: (x: number, z: number) => number;
  seed?: number;
}

export function createFerns(
  fog: HeightFog,
  opts: FernFieldOpts,
  sss?: { dir: THREE.Vector3; color: THREE.Color },
): THREE.Object3D {
  const rand = mulberry32(opts.seed ?? 31);
  const sssSunDir = { value: sss?.dir ?? new THREE.Vector3(0, 1, 0) };
  const sssColor = { value: sss?.color ?? new THREE.Color(0.9, 1.0, 0.5) };

  const mat = new THREE.MeshStandardMaterial({
    map: makeFern(11),
    alphaTest: 0.25,
    side: THREE.DoubleSide,
    roughness: 0.85,
    metalness: 0,
    vertexColors: true,
  });
  mat.envMapIntensity = 0.65;
  mat.onBeforeCompile = (shader) => {
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
          float backlit = pow( clamp( dot( -V, uSssSunDir ), 0.0, 1.0 ), 4.0 );
          reflectedLight.indirectDiffuse += diffuseColor.rgb * uSssColor * backlit * 0.6;
        }`,
      );
  };
  fog.patch(mat);
  mat.customProgramCacheKey = () => 'heightfog-fern-sss';

  const variants = [buildFernGeometry(5, 8), buildFernGeometry(6, 7), buildFernGeometry(9, 9)];
  const perVariant: THREE.Matrix4[][] = variants.map(() => []);

  let placed = 0;
  let attempts = 0;
  while (placed < opts.count && attempts < opts.count * 12) {
    attempts++;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * opts.radius;
    const x = Math.sin(a) * r;
    const z = Math.cos(a) * r;
    const d = opts.density ? opts.density(x, z) : 1;
    if (rand() > d) continue;

    const y = opts.heightAt(x, z);
    const s = 0.85 + rand() * 1.1;
    const m = new THREE.Matrix4()
      .makeRotationY(rand() * Math.PI * 2)
      .premultiply(new THREE.Matrix4().makeScale(s, s * (0.85 + rand() * 0.3), s))
      .setPosition(x, y - 0.03, z);
    perVariant[Math.floor(rand() * variants.length)].push(m);
    placed++;
  }

  const group = new THREE.Group();
  variants.forEach((v, i) => {
    const mats = perVariant[i];
    if (!mats.length) return;
    const im = new THREE.InstancedMesh(v, mat, mats.length);
    const tint = new THREE.Color();
    mats.forEach((m, j) => {
      im.setMatrixAt(j, m);
      tint.setHSL(0.24 + rand() * 0.1, 0.35 + rand() * 0.3, 0.32 + rand() * 0.22);
      im.setColorAt(j, tint);
    });
    im.castShadow = true;
    im.receiveShadow = true;
    group.add(im);
  });
  return group;
}
