import * as THREE from 'three/webgpu';
import { Fn, cameraPosition, float, int, storage, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { fillTileBorder, octEncodeNode } from './octahedral.ts';
import { PROBE_LAYER_ALL, PROBE_LAYER_INTERIOR, PROBE_STATE_SLOTS, layerOfPoint, packProbeRecord, probeLayers, probeState } from './probeLayers.ts';

export const IRRADIANCE_SIDE = 8;
export const DISTANCE_SIDE = 16;
const IRRADIANCE_TILE = IRRADIANCE_SIDE + 2;
const DISTANCE_TILE = DISTANCE_SIDE + 2;
const CHANNELS = 4;
const PROBE_STATE_ACTIVE = 1;
export const PROBE_STATE_EMPTY = 2;
export const PROBE_STATE_DILATED = 3;

export interface ProbeLayout {
  min: THREE.Vector3;
  spacing: number;
  dims: [number, number, number];
}

export interface ProbeVolumeStorage {
  min: [number, number, number];
  spacing: number;
  dims: [number, number, number];
  irradiance: Float32Array;
  irradianceSun: Float32Array;
  distance: Float32Array;
  probeData: Float32Array;
  bakedSunIntensity: number;
}

export function storageMatchesLayout(saved: ProbeVolumeStorage, layout: ProbeLayout): boolean {
  const sameDims = saved.dims.every((d, i) => d === layout.dims[i]);
  const sameMin = saved.min.every((m, i) => Math.abs(m - layout.min.getComponent(i)) < 1e-4);
  return sameDims && sameMin && Math.abs(saved.spacing - layout.spacing) < 1e-6;
}

export function fitProbeLayout(bounds: THREE.Box3, spacing: number, maxProbes: number): ProbeLayout {
  const size = bounds.getSize(new THREE.Vector3());
  let step = spacing;
  const dimsFor = (s: number): [number, number, number] => [
    Math.max(2, Math.ceil(size.x / s) + 1), Math.max(2, Math.ceil(size.y / s) + 1), Math.max(2, Math.ceil(size.z / s) + 1),
  ];
  let dims = dimsFor(step);
  while (dims[0] * dims[1] * dims[2] > maxProbes) { step *= 1.25; dims = dimsFor(step); }
  return { min: bounds.min.clone(), spacing: step, dims };
}

export function probeCount(layout: ProbeLayout): number {
  return layout.dims[0] * layout.dims[1] * layout.dims[2];
}

export function probeGridPosition(layout: ProbeLayout, index: number, out = new THREE.Vector3()): THREE.Vector3 {
  const [nx, ny] = layout.dims;
  const x = index % nx;
  const y = Math.floor(index / nx) % ny;
  const z = Math.floor(index / (nx * ny));
  return out.set(layout.min.x + x * layout.spacing, layout.min.y + y * layout.spacing, layout.min.z + z * layout.spacing);
}

function atlasTexture(width: number, height: number, name: string): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint16Array(width * height * CHANNELS), width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.name = name;
  tex.needsUpdate = true;
  return tex;
}

function toHalf(source: Float32Array, target: THREE.DataTexture): void {
  const data = target.image.data as Uint16Array;
  for (let i = 0; i < source.length; i++) data[i] = THREE.DataUtils.toHalfFloat(source[i]);
  target.needsUpdate = true;
}

/* @important DDGI storage (Majercik et al. 2019, RTXGI): per probe an 8x8 octahedral tile of cosine-
   convolved irradiance (stored as E/π, the surfel resolve's own scale) and a 16x16 tile of (mean
   distance, mean squared distance) for the Chebyshev visibility test at the sample, plus one
   record of relocation offset and active state. The sampler is `irradiance()` below. */
export class ProbeVolume {
  readonly count: number;
  readonly tilesPerRow: number;
  readonly rows: number;
  readonly irradiance: Float32Array;
  readonly irradianceSun: Float32Array;
  readonly distance: Float32Array;
  readonly probeData: Float32Array;
  readonly irradianceTexture: THREE.DataTexture;
  readonly irradianceSunTexture: THREE.DataTexture;
  readonly distanceTexture: THREE.DataTexture;
  readonly intensity = uniform(1);
  readonly sunScale = uniform(1);
  bakedSunIntensity = 1;
  readonly normalBias = uniform(0.1);
  readonly viewBias = uniform(0.1);
  readonly visibilityTest = uniform(1);
  private readonly probeDataAttribute: THREE.StorageBufferAttribute;
  private readonly probeRecords: THREE.Node;
  private readonly origin = uniform(new THREE.Vector3());
  private readonly cell = uniform(1);
  private readonly dims = uniform(new THREE.Vector3(1, 1, 1));
  readonly layersEnabled = uniform(1);
  interiorVolumes: THREE.Box3[] = [];
  forcedLayerMask: number | null = null;

  constructor(readonly layout: ProbeLayout) {
    this.count = probeCount(layout);
    this.tilesPerRow = Math.ceil(Math.sqrt(this.count));
    this.rows = Math.ceil(this.count / this.tilesPerRow);
    this.irradiance = new Float32Array(this.tilesPerRow * IRRADIANCE_TILE * this.rows * IRRADIANCE_TILE * CHANNELS);
    this.irradianceSun = new Float32Array(this.irradiance.length);
    this.distance = new Float32Array(this.tilesPerRow * DISTANCE_TILE * this.rows * DISTANCE_TILE * CHANNELS);
    this.probeData = new Float32Array(this.count * 4);
    for (let p = 0; p < this.count; p++) this.probeData[p * 4 + 3] = packProbeRecord(PROBE_STATE_ACTIVE, PROBE_LAYER_ALL);
    this.irradianceTexture = atlasTexture(this.tilesPerRow * IRRADIANCE_TILE, this.rows * IRRADIANCE_TILE, 'Probes / Irradiance');
    this.irradianceSunTexture = atlasTexture(this.tilesPerRow * IRRADIANCE_TILE, this.rows * IRRADIANCE_TILE, 'Probes / Irradiance from the sun');
    this.distanceTexture = atlasTexture(this.tilesPerRow * DISTANCE_TILE, this.rows * DISTANCE_TILE, 'Probes / Distance');
    this.probeDataAttribute = new THREE.StorageBufferAttribute(this.probeData, 4);
    this.probeRecords = storage(this.probeDataAttribute, 'vec4', this.count).toReadOnly().setName('probeRecords');
    this.origin.value.copy(layout.min);
    this.cell.value = layout.spacing;
    this.dims.value.set(layout.dims[0], layout.dims[1], layout.dims[2]);
    this.normalBias.value = 0.15 * layout.spacing;
    this.viewBias.value = 0.1 * layout.spacing;
  }

  tileOrigin(probe: number, tile: number): [number, number] {
    return [(probe % this.tilesPerRow) * tile, Math.floor(probe / this.tilesPerRow) * tile];
  }

  irradianceIndex(probe: number, texel: number): number {
    const [x0, y0] = this.tileOrigin(probe, IRRADIANCE_TILE);
    const x = x0 + 1 + (texel % IRRADIANCE_SIDE);
    const y = y0 + 1 + Math.floor(texel / IRRADIANCE_SIDE);
    return (y * this.tilesPerRow * IRRADIANCE_TILE + x) * CHANNELS;
  }

  distanceIndex(probe: number, texel: number): number {
    const [x0, y0] = this.tileOrigin(probe, DISTANCE_TILE);
    const x = x0 + 1 + (texel % DISTANCE_SIDE);
    const y = y0 + 1 + Math.floor(texel / DISTANCE_SIDE);
    return (y * this.tilesPerRow * DISTANCE_TILE + x) * CHANNELS;
  }

  probePosition(probe: number, out = new THREE.Vector3()): THREE.Vector3 {
    probeGridPosition(this.layout, probe, out);
    return out.add(new THREE.Vector3(this.probeData[probe * 4], this.probeData[probe * 4 + 1], this.probeData[probe * 4 + 2]));
  }

  setProbeOffset(probe: number, offset: THREE.Vector3): void {
    this.probeData[probe * 4] = offset.x; this.probeData[probe * 4 + 1] = offset.y; this.probeData[probe * 4 + 2] = offset.z;
  }

  private setState(probe: number, state: number): void {
    this.probeData[probe * 4 + 3] = packProbeRecord(state, probeLayers(this.probeData[probe * 4 + 3]));
  }

  setProbeActive(probe: number, active: boolean): void {
    this.setState(probe, active ? PROBE_STATE_ACTIVE : 0);
  }

  setProbeEmpty(probe: number): void {
    this.setState(probe, PROBE_STATE_EMPTY);
  }

  setProbeDilated(probe: number): void {
    this.setState(probe, PROBE_STATE_DILATED);
  }

  isEmpty(probe: number): boolean {
    return probeState(this.probeData[probe * 4 + 3]) === PROBE_STATE_EMPTY;
  }

  isActive(probe: number): boolean {
    return probeState(this.probeData[probe * 4 + 3]) >= PROBE_STATE_ACTIVE;
  }

  layersOf(probe: number): number {
    return probeLayers(this.probeData[probe * 4 + 3]);
  }

  assignLayers(interiorVolumes: THREE.Box3[]): { interior: number; exterior: number } {
    this.interiorVolumes = interiorVolumes;
    const position = new THREE.Vector3();
    let interior = 0;
    for (let p = 0; p < this.count; p++) {
      const layers = layerOfPoint(interiorVolumes, this.probePosition(p, position));
      this.probeData[p * 4 + 3] = packProbeRecord(probeState(this.probeData[p * 4 + 3]), layers);
      if (layers === PROBE_LAYER_INTERIOR) interior++;
    }
    this.probeDataAttribute.needsUpdate = true;
    return { interior, exterior: this.count - interior };
  }

  fillConstant(radiance: number): void {
    this.irradiance.fill(0);
    this.irradianceSun.fill(0);
    for (let i = 0; i < this.irradiance.length; i += CHANNELS) { this.irradiance[i] = radiance; this.irradiance[i + 1] = radiance; this.irradiance[i + 2] = radiance; this.irradiance[i + 3] = 1; }
    for (let i = 0; i < this.distance.length; i += CHANNELS) { this.distance[i] = 100; this.distance[i + 1] = 1e4; }
    this.upload();
  }

  load(saved: ProbeVolumeStorage): void {
    if (saved.irradiance.length !== this.irradiance.length || saved.distance.length !== this.distance.length || saved.probeData.length !== this.probeData.length) throw new Error('probes: saved volume does not match this layout');
    this.irradiance.set(saved.irradiance);
    if (saved.irradianceSun.length === this.irradianceSun.length) this.irradianceSun.set(saved.irradianceSun);
    else this.irradianceSun.fill(0);
    this.distance.set(saved.distance);
    this.probeData.set(saved.probeData);
    this.bakedSunIntensity = saved.bakedSunIntensity;
    this.upload();
  }

  export(): ProbeVolumeStorage {
    const { min, spacing, dims } = this.layout;
    return {
      min: [min.x, min.y, min.z], spacing, dims: [...dims], irradiance: this.irradiance.slice(), irradianceSun: this.irradianceSun.slice(),
      distance: this.distance.slice(), probeData: this.probeData.slice(), bakedSunIntensity: this.bakedSunIntensity,
    };
  }

  upload(): void {
    for (let p = 0; p < this.count; p++) {
      const [ix, iy] = [p % this.tilesPerRow, Math.floor(p / this.tilesPerRow)];
      fillTileBorder(this.irradiance, this.tilesPerRow * IRRADIANCE_TILE, ix, iy, IRRADIANCE_SIDE, CHANNELS);
      fillTileBorder(this.irradianceSun, this.tilesPerRow * IRRADIANCE_TILE, ix, iy, IRRADIANCE_SIDE, CHANNELS);
      fillTileBorder(this.distance, this.tilesPerRow * DISTANCE_TILE, ix, iy, DISTANCE_SIDE, CHANNELS);
    }
    toHalf(this.irradiance, this.irradianceTexture);
    toHalf(this.irradianceSun, this.irradianceSunTexture);
    toHalf(this.distance, this.distanceTexture);
    this.probeDataAttribute.needsUpdate = true;
  }

  private tileUv(probe: THREE.Node, oct: THREE.Node, side: number): THREE.Node {
    const tile = side + 2;
    const p = float(probe);
    const tx = p.mod(this.tilesPerRow).floor();
    const ty = p.div(this.tilesPerRow).floor();
    const texel = vec2(tx, ty).mul(tile).add(1).add(vec2(oct).mul(side));
    return texel.div(vec2(this.tilesPerRow * tile, this.rows * tile));
  }

  private probeRecord(index: THREE.Node): THREE.Node {
    return vec4((this.probeRecords as any).element(index));
  }

  irradianceAt(worldPosition: THREE.Node, worldNormal: THREE.Node, layerMask: THREE.Node = int(PROBE_LAYER_ALL)): THREE.Node {
    return Fn(() => {
      const P = vec3(worldPosition);
      const N = vec3(worldNormal).normalize();
      const toCamera = vec3(cameraPosition).sub(P).normalize();
      const biased = P.add(N.mul(this.normalBias)).add(toCamera.mul(this.viewBias));
      const local = biased.sub(this.origin).div(this.cell);
      const maxCell = vec3(this.dims).sub(1);
      const base = local.floor().clamp(vec3(0), maxCell.sub(1));
      const alpha = local.sub(base).clamp(0, 1);
      const [nx, ny] = [this.layout.dims[0], this.layout.dims[1]];
      let sum: any = vec3(0);
      let weightSum: any = float(0);
      for (let corner = 0; corner < 8; corner++) {
        const o = vec3(corner & 1, (corner >> 1) & 1, (corner >> 2) & 1);
        const coord = base.add(o);
        const index = coord.x.add(coord.y.mul(nx)).add(coord.z.mul(nx * ny)).toInt();
        const record = this.probeRecord(index);
        const probePos = this.origin.add(coord.mul(this.cell)).add(record.xyz);
        const trilinear = vec3(1).sub(alpha).mul(vec3(1).sub(o)).add(alpha.mul(o));
        const dirToProbe = probePos.sub(P).normalize();
        const wrap = dirToProbe.dot(N).add(1).mul(0.5);
        let weight: any = wrap.mul(wrap).add(0.2);
        const toBiased = biased.sub(probePos);
        const dist = toBiased.length();
        const dirFromProbe = toBiased.div(dist.max(1e-4));
        const moments = texture(this.distanceTexture, this.tileUv(index, octEncodeNode(dirFromProbe), DISTANCE_SIDE));
        const variance = moments.x.mul(moments.x).sub(moments.y).abs();
        const excess = dist.sub(moments.x).max(0);
        const chebyshev = variance.div(variance.add(excess.mul(excess)).max(1e-6));
        const visibility = dist.greaterThan(moments.x).select(chebyshev.mul(chebyshev).mul(chebyshev).max(0.05), float(1));
        weight = weight.mul(this.visibilityTest.greaterThan(0.5).select(visibility, float(1)));
        const state = record.w.mod(PROBE_STATE_SLOTS);
        const layers = record.w.div(PROBE_STATE_SLOTS).floor().toInt();
        const sameLayer = layers.bitAnd(layerMask).greaterThan(0).or(this.layersEnabled.lessThan(0.5));
        const accepted = state.greaterThan(0.5).and(sameLayer);
        const crush = weight.lessThan(0.2).select(weight.mul(weight).div(0.04), float(1));
        weight = accepted.select(weight.mul(crush).mul(trilinear.x.mul(trilinear.y).mul(trilinear.z)).max(1e-5), float(0));
        const irrUv = this.tileUv(index, octEncodeNode(N), IRRADIANCE_SIDE);
        const irr = texture(this.irradianceTexture, irrUv).rgb.add(texture(this.irradianceSunTexture, irrUv).rgb.mul(this.sunScale));
        sum = sum.add(irr.mul(weight));
        weightSum = weightSum.add(weight);
      }
      return weightSum.greaterThan(1e-6).select(sum.div(weightSum), vec3(0)).mul(this.intensity);
    })();
  }
}
