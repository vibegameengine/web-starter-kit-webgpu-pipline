import * as THREE from 'three/webgpu';
import { Fn, If, float, instanceIndex, int, ivec2, storage, textureStore, uniform, vec4 } from 'three/tsl';
import { SurfelMoments } from '../surfel/surfelPool.ts';
import type { SurfelGI } from '../surfelGI.ts';
import { IRRADIANCE_SIDE, type ProbeVolume } from './probeVolume.ts';

const TILE = IRRADIANCE_SIDE + 2;
const LAST = IRRADIANCE_SIDE + 1;
const SAMPLES_KEPT_ON_CHANGE = 4;

export interface ResidentProbeSurfels {
  texelSurfel: THREE.StorageBufferAttribute;
  size: number;
  directions: number;
}

export interface ProbeLiveSettings {
  rayBudget: number;
  raysPerSurfel: number;
}

function sourceTexel(x: ReturnType<typeof int>, y: ReturnType<typeof int>): [ReturnType<typeof int>, ReturnType<typeof int>] {
  const xEdge = x.equal(0).or(x.equal(LAST));
  const yEdge = y.equal(0).or(y.equal(LAST));
  const corner = xEdge.and(yEdge);
  const cornerX = x.equal(0).select(int(IRRADIANCE_SIDE), int(1));
  const cornerY = y.equal(0).select(int(IRRADIANCE_SIDE), int(1));
  const rowX = int(LAST).sub(x);
  const rowY = y.equal(0).select(int(1), int(IRRADIANCE_SIDE));
  const colX = x.equal(0).select(int(1), int(IRRADIANCE_SIDE));
  const colY = int(LAST).sub(y);
  const sx = corner.select(cornerX, yEdge.select(rowX, xEdge.select(colX, x)));
  const sy = corner.select(cornerY, yEdge.select(rowY, xEdge.select(colY, y)));
  return [sx, sy];
}

/* @important Lumen's and Cyberpunk's amortised cache, applied to the probes: the direction surfels stay
   resident after the bake and the atlas integrator keeps refreshing them under the ray-budget
   admission queue, so a moved sun reaches the probes over seconds without a re-bake. The copy
   kernel writes moments straight into the octahedral tiles, border texels included, and the frame
   samples the same DataTexture it always did through one texture-to-texture copy. */
export class ProbeLiveUpdate {
  readonly texture: THREE.StorageTexture;
  readonly settings: ProbeLiveSettings = { rayBudget: 8192, raysPerSurfel: 8 };
  private copyNode: THREE.ComputeNode | null = null;
  private invalidateNode: THREE.ComputeNode | null = null;
  invalidations = 0;
  private readonly uReadOffset = uniform(0);
  private readonly camera = new THREE.PerspectiveCamera();
  private gridBuilt = false;
  frames = 0;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly gi: SurfelGI,
    private readonly scene: THREE.Scene,
    private readonly volume: ProbeVolume,
    private readonly resident: ResidentProbeSurfels,
    viewpoint: THREE.Vector3,
  ) {
    const { width, height } = volume.irradianceTexture.image as { width: number; height: number };
    this.texture = new THREE.StorageTexture(width, height);
    this.texture.type = THREE.HalfFloatType;
    this.texture.format = THREE.RGBAFormat;
    this.texture.name = 'Probes / Live irradiance';
    this.camera.position.copy(viewpoint);
    this.camera.updateMatrixWorld();
  }

  private buildCopy(): THREE.ComputeNode {
    const { pool } = this.gi.bakeMachinery;
    const momentsAttr = pool.getMomentsAttr();
    if (!momentsAttr) throw new Error('probes: the pool has no moments');
    const capacity = pool.getCapacity();
    const moments = storage(momentsAttr, SurfelMoments, capacity * 2).toReadOnly().setName('liveProbeMoments');
    const texelSurfel = storage(this.resident.texelSurfel, 'int', this.resident.size * this.resident.size).toReadOnly().setName('liveProbeTexels');
    const { tilesPerRow, count } = this.volume;
    const directions = this.resident.directions;
    const target = this.texture;
    const readOffset = this.uReadOffset;
    return Fn(() => {
      const i = int(instanceIndex);
      const probe = i.div(TILE * TILE);
      const local = i.mod(TILE * TILE);
      const x = local.mod(TILE);
      const y = local.div(TILE);
      const [sx, sy] = sourceTexel(x, y);
      const direction = sy.sub(1).mul(IRRADIANCE_SIDE).add(sx.sub(1));
      const sid = texelSurfel.element(probe.mul(directions).add(direction));
      const pixel = ivec2(probe.mod(tilesPerRow).mul(TILE).add(x), probe.div(tilesPerRow).mul(TILE).add(y));
      If(sid.greaterThanEqual(0), () => {
        const irradiance = moments.element(sid.add(readOffset)).get('irradiance');
        textureStore(target, pixel, vec4(irradiance.xyz, 1));
      });
    })().compute(count * TILE * TILE).setName('Probe live copy');
  }

  /* @important MSME's long-term mean carries up to 200 samples, so a moved sun would take thousands
     of frames to show through it. Cutting every resident surfel's sample count to 4 makes the next
     integrations dominate: the probes re-converge in a few hundred frames instead. */
  private buildInvalidate(): THREE.ComputeNode {
    const { pool } = this.gi.bakeMachinery;
    const momentsAttr = pool.getMomentsAttr();
    if (!momentsAttr) throw new Error('probes: the pool has no moments');
    const capacity = pool.getCapacity();
    const moments = storage(momentsAttr, SurfelMoments, capacity * 2).setName('liveProbeMomentsRw');
    const texelSurfel = storage(this.resident.texelSurfel, 'int', this.resident.size * this.resident.size).toReadOnly().setName('liveProbeTexelsRw');
    const texels = this.volume.count * this.resident.directions;
    return Fn(() => {
      const sid = texelSurfel.element(int(instanceIndex));
      If(sid.greaterThanEqual(0), () => {
        for (const half of [0, capacity]) {
          const record = moments.element(sid.add(half));
          const irradiance = record.get('irradiance');
          record.get('irradiance').assign(vec4(irradiance.xyz, irradiance.w.min(float(SAMPLES_KEPT_ON_CHANGE))));
        }
      });
    })().compute(texels).setName('Probe live invalidate');
  }

  invalidate(): void {
    if (!this.invalidateNode) this.invalidateNode = this.buildInvalidate();
    this.renderer.compute(this.invalidateNode);
    this.invalidations++;
  }

  update(): void {
    const { pool, grid, integrate, integratorArgs, bvh, dynamicBvh, integrationSchedule } = this.gi.bakeMachinery;
    if (!integrate || !bvh || !dynamicBvh) return;
    if (!this.gridBuilt) { grid.build(this.renderer, pool, this.camera); this.gridBuilt = true; }
    this.gi.setBaseSampleCount(this.settings.raysPerSurfel);
    integrationSchedule.run(this.renderer, pool, this.settings.rayBudget, this.settings.raysPerSurfel);
    integratorArgs.run(this.renderer, pool);
    integrate.run(this.renderer, pool, bvh, dynamicBvh, grid, this.camera, this.scene, integratorArgs.getIndirectAttr(), { includeDynamic: false, schedule: true });
    pool.swapMoments();
    this.uReadOffset.value = pool.getOffsets().readOffset;
    if (!this.copyNode) this.copyNode = this.buildCopy();
    this.renderer.compute(this.copyNode);
    this.renderer.copyTextureToTexture(this.texture, this.volume.irradianceTexture);
    this.frames++;
  }
}
