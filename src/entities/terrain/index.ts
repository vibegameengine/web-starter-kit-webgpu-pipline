import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { makeLitter } from '../../shared/lib/organicTextures';

/**
 * Validation landscape — the "UE Open World default level" stand-in:
 * rolling green plain near the camera lifting into rocky, snow-capped
 * ridges toward the rim. Vertex-colored splat (grass/rock/snow by
 * height + slope); real texture splatting arrives with the forest pass.
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

export class Terrain {
  readonly mesh: THREE.Mesh;
  readonly size: number;
  private n1 = createNoise2D(mulberry32(1337));
  private n2 = createNoise2D(mulberry32(9001));
  private nw = createNoise2D(mulberry32(4242));

  constructor(size = 3000, segments = 400) {
    this.size = size;

    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const grass = new THREE.Color(0.13, 0.22, 0.08);
    const grassDry = new THREE.Color(0.22, 0.24, 0.1);
    const rock = new THREE.Color(0.26 / 0.5, 0.25 / 0.39, 0.24 / 0.28); // pre-divided by litter-map tint
    const snow = new THREE.Color(1.75 / 0.5, 1.85 / 0.39, 2.0 / 0.28);
    const distantForest = new THREE.Color(0.10 / 0.5, 0.16 / 0.39, 0.09 / 0.28);
    const c = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.height(x, z);
      pos.setY(i, h);
    }
    geo.computeVertexNormals();

    const nrm = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = pos.getY(i);
      const slope = 1 - nrm.getY(i);

      const variation = this.n2(x * 0.008, z * 0.008) * 0.5 + 0.5;
      c.copy(grass).lerp(grassDry, variation * 0.7);

      // forest floor: needle-litter browns take over near the center
      const litterA = new THREE.Color(0.42, 0.31, 0.20);
      const litterB = new THREE.Color(0.26, 0.33, 0.16); // mossy
      const forestW = 1 - THREE.MathUtils.smoothstep(Math.hypot(x, z), 380, 720);
      const litter = new THREE.Color().copy(litterA).lerp(litterB, variation);
      c.lerp(litter, forestW);

      // rock on steep slopes
      const rockW = THREE.MathUtils.smoothstep(slope, 0.22, 0.5);
      c.lerp(rock, rockW);

      // distant slopes read as tree-covered below the rock line
      const mountainW = THREE.MathUtils.smoothstep(h, 25, 90) * THREE.MathUtils.smoothstep(Math.hypot(x, z), 450, 800);
      c.lerp(distantForest, mountainW * (1 - THREE.MathUtils.smoothstep(h, 200, 290)) * (1 - THREE.MathUtils.smoothstep(slope, 0.45, 0.7)));

      // snow on high, flat-enough ground
      const snowLine = 150 + this.n1(x * 0.004, z * 0.004) * 40;
      const snowW = THREE.MathUtils.smoothstep(h, snowLine, snowLine + 70) * (1 - THREE.MathUtils.smoothstep(slope, 0.5, 0.8));
      c.lerp(snow, snowW);

      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // needle-litter detail; vertex colors carry the macro splat
    const litterTex = makeLitter(19);
    litterTex.map.repeat.setScalar(size / 7);
    litterTex.normalMap.repeat.setScalar(size / 7);

    const mat = new THREE.MeshStandardMaterial({
      map: litterTex.map,
      normalMap: litterTex.normalMap,
      normalScale: new THREE.Vector2(0.7, 0.7),
      vertexColors: true,
      roughness: 0.96,
      metalness: 0,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
  }

  private fbm(fn: (x: number, y: number) => number, x: number, z: number, oct: number): number {
    let f = 1, a = 0.5, s = 0, n = 0;
    for (let i = 0; i < oct; i++) {
      s += a * fn(x * f, z * f);
      n += a;
      f *= 2.02;
      a *= 0.5;
    }
    return s / n;
  }

  height(x: number, z: number): number {
    const wx = x + this.nw(x * 0.0012, z * 0.0012) * 80;
    const wz = z + this.nw(x * 0.0012 + 3.1, z * 0.0012 + 3.1) * 80;

    // rolling plain
    let h = this.fbm(this.n1, wx * 0.002, wz * 0.002, 5) * 18;
    h += this.fbm(this.n1, wx * 0.015, wz * 0.015, 3) * 1.6;

    // mountains rising toward the rim (ridged fbm, low frequency = broad massifs)
    const r = Math.hypot(x, z) / (this.size * 0.5);
    const rim = Math.pow(THREE.MathUtils.smoothstep(r, 0.5, 1.05), 1.5);
    const ridge = 1 - Math.abs(this.fbm(this.n2, wx * 0.0008, wz * 0.0008, 4));
    const swell = this.fbm(this.n1, wx * 0.0011, wz * 0.0011, 3) * 0.5 + 0.5;
    const detail = this.fbm(this.n2, wx * 0.004, wz * 0.004, 4) * 55;
    h += rim * (Math.pow(ridge, 1.6) * 430 + swell * 160 + detail * Math.min(1, ridge * 1.5));

    return h;
  }

  normalY(x: number, z: number): number {
    const e = 2;
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    return (2 * e) / Math.hypot(hx, 2 * e, hz);
  }
}
