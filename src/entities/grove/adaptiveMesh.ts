import * as THREE from 'three/webgpu';

export type Cover = readonly [number, number, number];

export interface AdaptiveMeshParams {
  half: number;
  maxQuadMeters: number;
  minQuadMeters: number;
  detailFactor: number;
  detailDistance: (x: number, z: number) => number;
  sampleHeight: (x: number, z: number) => number;
  sampleCover: (x: number, z: number) => Cover;
  uvRepeatsPerMetre: number;
}

export interface AdaptiveMeshData {
  geometry: THREE.BufferGeometry;
  triangleCount: number;
  leafCount: number;
}

const NORMAL_STEP_METERS = 0.06;

interface Point {
  x: number;
  z: number;
}

type SplitRules = Pick<AdaptiveMeshParams, 'maxQuadMeters' | 'minQuadMeters' | 'detailFactor' | 'detailDistance'>;

export function quadSplits(rules: SplitRules, cx: number, cz: number, size: number): boolean {
  if (size <= rules.minQuadMeters) return false;
  if (size > rules.maxQuadMeters) return true;
  return rules.detailDistance(cx, cz) < size * rules.detailFactor;
}

function leafRing(params: AdaptiveMeshParams, cx: number, cz: number, size: number): { ring: Point[]; stitched: boolean } {
  const h = size / 2;
  const corners: Point[] = [
    { x: cx + h, z: cz + h },
    { x: cx + h, z: cz - h },
    { x: cx - h, z: cz - h },
    { x: cx - h, z: cz + h },
  ];
  const edges = [
    { neighbour: { x: cx + size, z: cz }, mid: { x: cx + h, z: cz } },
    { neighbour: { x: cx, z: cz - size }, mid: { x: cx, z: cz - h } },
    { neighbour: { x: cx - size, z: cz }, mid: { x: cx - h, z: cz } },
    { neighbour: { x: cx, z: cz + size }, mid: { x: cx, z: cz + h } },
  ];
  const ring: Point[] = [];
  let stitched = false;
  for (let i = 0; i < 4; i++) {
    ring.push(corners[i]);
    if (quadSplits(params, edges[i].neighbour.x, edges[i].neighbour.z, size)) {
      ring.push(edges[i].mid);
      stitched = true;
    }
  }
  return { ring, stitched };
}

class Mesher {
  private readonly positions: number[] = [];
  private readonly uvs: number[] = [];
  private readonly covers: number[] = [];
  private readonly normals: number[] = [];
  leaves = 0;

  constructor(private readonly params: AdaptiveMeshParams) {}

  vertex(x: number, z: number): void {
    const params = this.params;
    this.positions.push(x, params.sampleHeight(x, z), z);
    this.uvs.push(x * params.uvRepeatsPerMetre, z * params.uvRepeatsPerMetre);
    const cover = params.sampleCover(x, z);
    this.covers.push(cover[0], cover[1], cover[2]);
    const step = NORMAL_STEP_METERS;
    const slopeX = params.sampleHeight(x + step, z) - params.sampleHeight(x - step, z);
    const slopeZ = params.sampleHeight(x, z + step) - params.sampleHeight(x, z - step);
    const nx = -slopeX / (2 * step);
    const nz = -slopeZ / (2 * step);
    const length = Math.hypot(nx, 1, nz);
    this.normals.push(nx / length, 1 / length, nz / length);
  }

  subdivide(cx: number, cz: number, size: number): void {
    if (!quadSplits(this.params, cx, cz, size)) {
      this.leaves++;
      this.leaf(cx, cz, size);
      return;
    }
    const quarter = size / 4;
    const child = size / 2;
    this.subdivide(cx - quarter, cz - quarter, child);
    this.subdivide(cx + quarter, cz - quarter, child);
    this.subdivide(cx - quarter, cz + quarter, child);
    this.subdivide(cx + quarter, cz + quarter, child);
  }

  private leaf(cx: number, cz: number, size: number): void {
    const { ring, stitched } = leafRing(this.params, cx, cz, size);
    if (!stitched) {
      const [a, b, c, d] = ring;
      for (const p of [a, b, c, a, c, d]) this.vertex(p.x, p.z);
      return;
    }
    for (let i = 0; i < ring.length; i++) {
      const current = ring[i];
      const next = ring[(i + 1) % ring.length];
      this.vertex(cx, cz);
      this.vertex(current.x, current.z);
      this.vertex(next.x, next.z);
    }
  }

  geometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('cover', new THREE.Float32BufferAttribute(this.covers, 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  get triangleCount(): number {
    return this.positions.length / 9;
  }
}

/**
 * @important Normals come from the height field by central difference, not from the
 * triangles: the mesh is non-indexed, so face normals would shade every leaf faceted
 * and would break exactly where two leaf sizes meet, which is where the eye looks.
 */
export function buildAdaptiveMesh(params: AdaptiveMeshParams): AdaptiveMeshData {
  const mesher = new Mesher(params);
  mesher.subdivide(0, 0, params.half * 2);
  return { geometry: mesher.geometry(), triangleCount: mesher.triangleCount, leafCount: mesher.leaves };
}
