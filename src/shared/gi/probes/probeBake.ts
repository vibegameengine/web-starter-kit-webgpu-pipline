import * as THREE from 'three/webgpu';
import type { SurfelGI } from '../surfelGI.ts';
import { createLightmapSurfels } from '../bake/lightmapSurfels.ts';
import type { LightmapGBuffer } from '../bake/lightmapGBuffer.ts';
import type { ContactBVHBundle } from '../contact/contactBvh.ts';
import { readFloatTexture } from '../../render/gpuReadback.ts';
import { MAX_SURFELS } from '../surfel/constants.ts';
import { DISTANCE_SIDE, IRRADIANCE_SIDE, ProbeVolume } from './probeVolume.ts';
import { texelDirection } from './octahedral.ts';
import { ProbeTracePass, type ProbeTrace } from './probeTracePass.ts';
import type { ResidentProbeSurfels } from './probeLive.ts';
import { classifyProbes, dilateInactiveProbes, writeDistances } from './probeClassify.ts';

export interface ProbeBakeOptions {
  iterations: number;
  raysPerSurfel: number;
  viewpoint: THREE.Vector3;
  relocationPasses?: number;
  classify?: boolean;
  sunSplit?: { sunIntensity: number; skyOnly: () => void; restore: () => void };
  keepResident?: boolean;
  onProgress?: (stage: string, fraction: number) => void;
}

const MAX_BATCH_TEXELS = 65536;

function dataTexture(data: Float32Array, size: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

function directionTable(side: number): { list: THREE.Vector3[]; packed: Float32Array } {
  const list: THREE.Vector3[] = [];
  const packed = new Float32Array(side * side * 4);
  for (let t = 0; t < side * side; t++) {
    const d = texelDirection(t, side);
    list.push(d);
    packed[t * 4] = d.x; packed[t * 4 + 1] = d.y; packed[t * 4 + 2] = d.z; packed[t * 4 + 3] = 0;
  }
  return { list, packed };
}

function probeOrigins(volume: ProbeVolume): Float32Array {
  const origins = new Float32Array(volume.count * 4);
  const p = new THREE.Vector3();
  for (let probe = 0; probe < volume.count; probe++) {
    volume.probePosition(probe, p);
    origins[probe * 4] = p.x; origins[probe * 4 + 1] = p.y; origins[probe * 4 + 2] = p.z; origins[probe * 4 + 3] = 1;
  }
  return origins;
}

function batchGBuffer(volume: ProbeVolume, first: number, count: number, directions: THREE.Vector3[], size: number): LightmapGBuffer {
  const positions = new Float32Array(size * size * 4);
  const normals = new Float32Array(size * size * 4);
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    volume.probePosition(first + i, p);
    for (let k = 0; k < directions.length; k++) {
      const t = (i * directions.length + k) * 4;
      positions[t] = p.x; positions[t + 1] = p.y; positions[t + 2] = p.z; positions[t + 3] = 1;
      normals[t] = directions[k].x; normals[t + 1] = directions[k].y; normals[t + 2] = directions[k].z; normals[t + 3] = 1;
    }
  }
  const position = dataTexture(positions, size);
  const normal = dataTexture(normals, size);
  const target = new THREE.RenderTarget(1, 1);
  return { target, position, normal, dispose: () => { position.dispose(); normal.dispose(); target.dispose(); } };
}

async function integrateSeeded(renderer: THREE.WebGPURenderer, gi: SurfelGI, scene: THREE.Scene, options: ProbeBakeOptions, stage: string): Promise<void> {
  const { pool, grid, integrate, integratorArgs, bvh, dynamicBvh } = gi.bakeMachinery;
  if (!integrate || !bvh || !dynamicBvh) throw new Error('probes: build the scene before baking');
  const camera = new THREE.PerspectiveCamera();
  camera.position.copy(options.viewpoint);
  camera.updateMatrixWorld();
  for (let i = 0; i < options.iterations; i++) {
    renderer.info.frame++;
    grid.build(renderer, pool, camera);
    integratorArgs.run(renderer, pool);
    integrate.run(renderer, pool, bvh, dynamicBvh, grid, camera, scene, integratorArgs.getIndirectAttr(), { includeDynamic: false });
    pool.swapMoments();
    options.onProgress?.(stage, (i + 1) / options.iterations);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

async function bakeIrradianceBatch(renderer: THREE.WebGPURenderer, gi: SurfelGI, scene: THREE.Scene, volume: ProbeVolume, batch: { first: number; count: number; directions: THREE.Vector3[]; options: ProbeBakeOptions; stage: string; target: Float32Array; keep?: boolean }): Promise<ResidentProbeSurfels> {
  const { first, count, directions, options } = batch;
  const texels = count * directions.length;
  const size = 2 ** Math.ceil(Math.log2(Math.sqrt(texels)));
  const gbuffer = batchGBuffer(volume, first, count, directions, size);
  gi.resetCache(renderer);
  gi.ensurePoolCapacity(renderer, size * size);
  const surfels = createLightmapSurfels(gi.bakeMachinery.pool, size);
  if (!surfels.seed(renderer, gbuffer)) throw new Error('probes: the pool refused the seed');
  const seeded = await surfels.countSeeded(renderer);
  if (seeded < texels) throw new Error(`probes: ${seeded}/${texels} probe surfels seeded`);
  gi.setBaseSampleCount(options.raysPerSurfel);
  await integrateSeeded(renderer, gi, scene, options, batch.stage);
  surfels.writeAtlas(renderer, gbuffer, { denoise: 0, dilate: 0 });
  const pixels = (await readFloatTexture(renderer, surfels.lightmap)).data;
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < directions.length; k++) {
      const texel = i * directions.length + k;
      const s = ((Math.floor(texel / size)) * size + (texel % size)) * 4;
      const d = volume.irradianceIndex(first + i, k);
      batch.target[d] = pixels[s]; batch.target[d + 1] = pixels[s + 1]; batch.target[d + 2] = pixels[s + 2]; batch.target[d + 3] = 1;
    }
  }
  gbuffer.dispose();
  if (!batch.keep) gi.resetCache(renderer);
  return { texelSurfel: surfels.texelSurfel, size, directions: directions.length };
}

async function relocate(tracer: ProbeTracePass, volume: ProbeVolume, directions: THREE.Vector3[], packed: Float32Array, options: ProbeBakeOptions): Promise<ProbeTrace> {
  const passes = options.classify === false ? 0 : (options.relocationPasses ?? 3);
  const maxDistance = 2 * volume.layout.spacing * Math.SQRT2;
  let trace = await tracer.trace(probeOrigins(volume), packed, maxDistance);
  if (options.classify === false) return trace;
  for (let pass = 0; pass < passes; pass++) {
    const moved = classifyProbes(volume, trace, directions);
    options.onProgress?.('relocation', (pass + 1) / passes);
    if (moved === 0) break;
    trace = await tracer.trace(probeOrigins(volume), packed, maxDistance);
  }
  classifyProbes(volume, trace, directions, { relocate: false });
  return trace;
}

/* @important Two bakes, not a shadow-ray flag: the sky pass runs with the sun at 0, the atlas reads off and
   the pool holding only the probe surfels, so it has no bounce at all; the sun term is therefore the
   direct sun at first hits plus every bounce, sky bounces included, and `sunScale` moves those too.
   The sky pass cannot read the atlas because the atlas itself was lit by the sun. */
async function bakeSkyThenSun(volume: ProbeVolume, split: { skyOnly: () => void; restore: () => void }, bakeInto: (target: Float32Array, label: string, keep?: boolean) => Promise<void>, keepResident: boolean): Promise<void> {
  split.skyOnly();
  try { await bakeInto(volume.irradiance, 'sky'); } finally { split.restore(); }
  const full = new Float32Array(volume.irradiance.length);
  await bakeInto(full, 'irradiance', keepResident);
  for (let i = 0; i < full.length; i += 4) {
    for (let c = 0; c < 3; c++) volume.irradianceSun[i + c] = Math.max(0, full[i + c] - volume.irradiance[i + c]);
    volume.irradianceSun[i + 3] = 1;
  }
}

export async function bakeProbeVolume(renderer: THREE.WebGPURenderer, gi: SurfelGI, scene: THREE.Scene, volume: ProbeVolume, bvh: ContactBVHBundle, options: ProbeBakeOptions): Promise<{ active: number; texels: number; resident?: ResidentProbeSurfels }> {
  const distance = directionTable(DISTANCE_SIDE);
  const tracer = new ProbeTracePass(renderer, bvh);
  const trace = await relocate(tracer, volume, distance.list, distance.packed, options);
  writeDistances(volume, trace, distance.list);
  const irradiance = directionTable(IRRADIANCE_SIDE);
  const residentFits = volume.count * irradiance.list.length <= MAX_SURFELS;
  const keepResident = options.keepResident === true && residentFits;
  if (options.keepResident && !residentFits) console.warn(`[probes] ${volume.count * irradiance.list.length} direction surfels exceed the pool ceiling; probes stay baked, not live`);
  let resident: ResidentProbeSurfels | undefined;
  const bakeInto = async (target: Float32Array, label: string, keep = false) => {
    const cap = keep ? MAX_SURFELS : MAX_BATCH_TEXELS;
    const per = Math.max(1, Math.floor(cap / irradiance.list.length));
    const total = Math.ceil(volume.count / per);
    for (let b = 0; b < total; b++) {
      const first = b * per;
      const count = Math.min(per, volume.count - first);
      resident = await bakeIrradianceBatch(renderer, gi, scene, volume, { first, count, directions: irradiance.list, options, stage: `${label} ${b + 1}/${total}`, target, keep });
    }
  };
  volume.irradianceSun.fill(0);
  volume.bakedSunIntensity = options.sunSplit?.sunIntensity ?? 1;
  if (options.sunSplit && options.sunSplit.sunIntensity > 0) await bakeSkyThenSun(volume, options.sunSplit, bakeInto, keepResident);
  else await bakeInto(volume.irradiance, 'irradiance', keepResident);
  const active = dilateInactiveProbes(volume);
  volume.upload();
  return { active, texels: volume.count * irradiance.list.length, resident: keepResident ? resident : undefined };
}

export async function seedResidentProbes(renderer: THREE.WebGPURenderer, gi: SurfelGI, volume: ProbeVolume): Promise<ResidentProbeSurfels | undefined> {
  const directions = directionTable(IRRADIANCE_SIDE);
  const texels = volume.count * directions.list.length;
  if (texels > MAX_SURFELS) { console.warn(`[probes] ${texels} direction surfels exceed the pool ceiling; probes stay baked, not live`); return undefined; }
  const size = 2 ** Math.ceil(Math.log2(Math.sqrt(texels)));
  const gbuffer = batchGBuffer(volume, 0, volume.count, directions.list, size);
  gi.resetCache(renderer);
  gi.ensurePoolCapacity(renderer, size * size);
  const surfels = createLightmapSurfels(gi.bakeMachinery.pool, size);
  if (!surfels.seed(renderer, gbuffer)) throw new Error('probes: the pool refused the seed');
  const seeded = await surfels.countSeeded(renderer);
  gbuffer.dispose();
  if (seeded < texels) throw new Error(`probes: ${seeded}/${texels} probe surfels seeded`);
  return { texelSurfel: surfels.texelSurfel, size, directions: directions.list.length };
}
