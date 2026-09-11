import * as THREE from 'three/webgpu';
import { sampler, texture, uniform, wgslFn } from 'three/tsl';
import { constants, intersectionResultStruct, rayStruct, bvhIntersectFirstHit, getVertexAttribute, intersectsBounds, bvhNodeStruct } from '../../bvh/webgpu/index.js';
import {
  dynBoundsHit,
  dynBvhIntersectFirstHit,
  getDynVertexAttribute,
  sceneHitStruct,
  traceScene,
  traceSceneOccluded,
  type DynamicBVHBundle,
} from '../../surfel/dynamicBvh.ts';
import { giLightConsts, giHitEmissive, giOccluded, giSampleLight, giShadeHit, giVisibility } from '../../surfel/hitShading.ts';
import { envEquirectUV, sampleDiffuseArray } from '../../surfel/surfelIntegratePass.ts';
import { giLightsTexture, U_GI_LIGHT_COUNT, U_GI_LIGHT_SAMPLES, U_GI_MEDIUM, U_GI_EMISSIVE_BASE, U_GI_EMISSIVE_SCALE } from '../../surfel/sceneLights.ts';
import { U_LOOK_INDIRECT_CHROMA, U_LOOK_INDIRECT_GAIN } from '../../../render/look.ts';
import type { ContactBVHBundle } from '../../contact/contactBvh.ts';
import type { ProbeVolume } from '../../probes/probeVolume.ts';
import { cubeConstants, faceDirection, hammersley, hash21, importanceGgx, jacobian, neighborTexel, sampleScratch, directionToFace } from './reflectionCubeWgsl.ts';
import { artisticIndirectWgsl, octEncodeWgsl, probeIrradianceWgsl, probeTileUv } from './reflectionProbeIndirect.ts';
import { CAPTURE_KERNEL, CAPTURE_SHADE } from './reflectionCaptureWgsl.ts';
import { BASE_COPY_KERNEL, FREEZE_KERNEL, LANE_KERNEL, MIP_OFFSET, PREFILTER_KERNEL, REDUCE_KERNEL } from './reflectionFilterWgsl.ts';
import { ReflectionResources, STATS_LANES } from './reflectionResources.ts';
import { roughnessOfLevel } from './reflectionTypes.ts';

export interface CaptureSources {
  staticBvh: ContactBVHBundle;
  dynamicBvh: DynamicBVHBundle;
  diffuseArray: THREE.Texture;
  environment: THREE.Texture;
  probes: ProbeVolume;
}

export interface CaptureSlice {
  base: number;
  count: number;
  slot: number;
  backBank: number;
  sampleTarget: number;
  visitCap: number;
  sampleStride: number;
}

const mipOffsetWgsl = wgslFn(MIP_OFFSET);

export class ReflectionPasses {
  private captureKernel: THREE.ComputeNode | null = null;
  private freezeKernel: THREE.ComputeNode | null = null;
  private baseCopyKernel: THREE.ComputeNode | null = null;
  private prefilterKernels: THREE.ComputeNode[] = [];
  private laneKernel: THREE.ComputeNode | null = null;
  private reduceKernel: THREE.ComputeNode | null = null;

  private readonly uAnchor = uniform(new THREE.Vector3());
  private readonly uJob = uniform(new THREE.Vector4());
  private readonly uLayout = uniform(new THREE.Vector4());
  private readonly uBudget = uniform(new THREE.Vector4());
  private readonly uEnvIntensity = uniform(1);
  private readonly uSkyKnee = uniform(5);
  private readonly uDynTrace = uniform(0);
  private readonly uGridOrigin = uniform(new THREE.Vector3());
  private readonly uGridCell = uniform(1);
  private readonly uGridDims = uniform(new THREE.Vector3(1, 1, 1));
  private readonly uAtlasTiles = uniform(new THREE.Vector2(1, 1));
  private readonly uProbeBias = uniform(new THREE.Vector2());
  private readonly uProbeScales = uniform(new THREE.Vector3(1, 1, 0));
  private readonly uLook = uniform(new THREE.Vector2(1, 1));
  private readonly uFreezeJob = uniform(new THREE.Vector4());
  private readonly uFreezeLayout = uniform(new THREE.Vector4());
  private readonly uStatsJob = uniform(new THREE.Vector4());
  private readonly uStatsLayout = uniform(new THREE.Vector4());
  private readonly prefilterJob = uniform(new THREE.Vector4());
  private readonly prefilterLayouts: THREE.UniformNode<THREE.Vector4>[] = [];
  private readonly prefilterArgs: THREE.UniformNode<THREE.Vector4>[] = [];

  readonly sliceTexels: number;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly resources: ReflectionResources,
    private readonly sources: CaptureSources,
    sliceTexels: number,
  ) {
    this.sliceTexels = Math.min(sliceTexels, resources.layout.baseTexels);
    this.buildCapture();
    this.buildFilters();
    this.buildStats();
  }

  private captureIncludes(): unknown[] {
    const { staticBvh, dynamicBvh, probes } = this.sources;
    return [
      wgslFn(CAPTURE_SHADE, [
        sceneHitStruct,
        rayStruct,
        envEquirectUV,
        sampleDiffuseArray,
        giHitEmissive,
        giShadeHit,
        probeIrradianceWgsl,
        probeTileUv,
        octEncodeWgsl,
        artisticIndirectWgsl,
        constants,
        probes.recordsNode,
      ] as never),
      traceScene,
      traceSceneOccluded,
      bvhIntersectFirstHit,
      dynBvhIntersectFirstHit,
      dynBoundsHit,
      getVertexAttribute,
      getDynVertexAttribute,
      intersectsBounds,
      giLightConsts,
      giOccluded,
      giVisibility,
      giSampleLight,
      giShadeHit,
      giHitEmissive,
      sceneHitStruct,
      rayStruct,
      bvhNodeStruct,
      intersectionResultStruct,
      constants,
      cubeConstants,
      faceDirection,
      directionToFace,
      jacobian,
      hash21,
      probes.recordsNode,
      staticBvh.bvhNode,
      staticBvh.positionNode,
      staticBvh.indexNode,
      staticBvh.attributeNode,
      dynamicBvh.bvhNode,
      dynamicBvh.positionNode,
      dynamicBvh.indexNode,
      dynamicBvh.colorNode,
      this.resources.rawWrite,
    ];
  }

  private buildCapture(): void {
    const { diffuseArray, environment, probes, dynamicBvh } = this.sources;
    const fn = wgslFn(CAPTURE_KERNEL, this.captureIncludes() as never);
    this.captureKernel = fn({
      diffuseTex: texture(diffuseArray),
      diffuseSampler: sampler(diffuseArray),
      envTex: texture(environment),
      envSampler: sampler(environment),
      envIntensity: this.uEnvIntensity,
      skyKnee: this.uSkyKnee,
      lightsTex: giLightsTexture,
      lightCount: U_GI_LIGHT_COUNT,
      lightSamples: U_GI_LIGHT_SAMPLES,
      medium: U_GI_MEDIUM,
      emissiveBase: U_GI_EMISSIVE_BASE,
      emissiveScale: U_GI_EMISSIVE_SCALE,
      probeIrrTex: texture(probes.irradianceTexture),
      probeIrrSampler: sampler(probes.irradianceTexture),
      probeSunTex: texture(probes.irradianceSunTexture),
      probeDistTex: texture(probes.distanceTexture),
      gridOrigin: this.uGridOrigin,
      gridCell: this.uGridCell,
      gridDims: this.uGridDims,
      atlasTiles: this.uAtlasTiles,
      probeBias: this.uProbeBias,
      probeScales: this.uProbeScales,
      probeVisibility: probes.visibilityTest,
      look: this.uLook,
      dynTrace: this.uDynTrace,
      dynBounds: dynamicBvh.influence,
      anchor: this.uAnchor,
      job: this.uJob,
      cubeDims: this.uLayout,
      budget: this.uBudget,
    })
      .compute(this.sliceTexels)
      .setName('Reflection capture');
  }

  private buildFilters(): void {
    const { layout, slots } = this.resources;
    this.freezeKernel = wgslFn(FREEZE_KERNEL, [this.resources.rawRead, this.resources.scratchWrite, this.resources.depthWrite] as never)({
      job: this.uFreezeJob,
      cubeDims: this.uFreezeLayout,
    })
      .compute(layout.baseTexels)
      .setName('Reflection freeze');

    this.baseCopyKernel = wgslFn(BASE_COPY_KERNEL, [this.resources.scratchRead, this.resources.radianceWrite] as never)({
      job: this.uFreezeJob,
      cubeDims: this.uFreezeLayout,
    })
      .compute(layout.baseTexels)
      .setName('Reflection base copy');

    for (let level = 1; level < layout.levels; level++) {
      const side = layout.faceSize >> level;
      const levelUniform = uniform(new THREE.Vector4(layout.faceSize, level, side, 64));
      const argsUniform = uniform(new THREE.Vector4(roughnessOfLevel(level, layout.levels), 0, 0, 0));
      this.prefilterLayouts.push(levelUniform as THREE.UniformNode<THREE.Vector4>);
      this.prefilterArgs.push(argsUniform as THREE.UniformNode<THREE.Vector4>);
      const kernel = wgslFn(PREFILTER_KERNEL, [
        mipOffsetWgsl,
        faceDirection,
        directionToFace,
        neighborTexel,
        sampleScratch,
        importanceGgx,
        hammersley,
        this.resources.scratchRead,
        this.resources.radianceWrite,
      ] as never)({
        job: this.prefilterJob,
        cubeDims: levelUniform,
        filterArgs: argsUniform,
      })
        .compute(6 * side * side)
        .setName(`Reflection prefilter ${level}`);
      this.prefilterKernels.push(kernel);
    }
    this.prefilterJob.value.set(0, 0, slots, layout.chainTexels);
  }

  private buildStats(): void {
    this.laneKernel = wgslFn(LANE_KERNEL, [cubeConstants, this.resources.rawRead, this.resources.laneWrite] as never)({
      job: this.uStatsJob,
      cubeDims: this.uStatsLayout,
    })
      .compute(STATS_LANES)
      .setName('Reflection stats lanes');
    this.reduceKernel = wgslFn(REDUCE_KERNEL, [this.resources.laneRead, this.resources.statsWrite] as never)({
      cubeDims: this.uStatsLayout,
    })
      .compute(1)
      .setName('Reflection stats reduce');
  }

  syncLighting(anchor: THREE.Vector3, envIntensity: number, skyKnee: number, dynamicEnabled: boolean): void {
    const probes = this.sources.probes;
    this.uAnchor.value.copy(anchor);
    this.uEnvIntensity.value = envIntensity;
    this.uSkyKnee.value = skyKnee;
    this.uDynTrace.value = dynamicEnabled ? 1 : 0;
    this.uGridOrigin.value.copy(probes.layout.min);
    this.uGridCell.value = probes.layout.spacing;
    this.uGridDims.value.set(probes.layout.dims[0], probes.layout.dims[1], probes.layout.dims[2]);
    this.uAtlasTiles.value.set(probes.tilesPerRow, probes.rows);
    this.uProbeBias.value.set(probes.normalBias.value, probes.viewBias.value);
    this.uProbeScales.value.set(probes.intensity.value, probes.sunScale.value, 0);
    this.uLook.value.set(U_LOOK_INDIRECT_GAIN.value, U_LOOK_INDIRECT_CHROMA.value);
  }

  capture(slice: CaptureSlice): void {
    if (!this.captureKernel) return;
    this.uJob.value.set(slice.base, slice.count, slice.slot, slice.backBank);
    this.uLayout.value.set(this.resources.layout.faceSize, this.resources.slots, slice.sampleTarget, 8);
    this.uBudget.value.set(slice.visitCap, slice.sampleStride, 0, 0);
    this.renderer.compute(this.captureKernel);
  }

  freezeAndFilter(slot: number, backBank: number, prefilterSamples: number): void {
    const { layout, slots } = this.resources;
    this.uFreezeJob.value.set(slot, backBank, slots, layout.chainTexels);
    this.uFreezeLayout.value.set(layout.faceSize, layout.levels, 0, 0);
    this.prefilterJob.value.set(slot, backBank, slots, layout.chainTexels);
    if (this.freezeKernel) this.renderer.compute(this.freezeKernel);
    if (this.baseCopyKernel) this.renderer.compute(this.baseCopyKernel);
    for (let i = 0; i < this.prefilterKernels.length; i++) {
      this.prefilterLayouts[i].value.w = prefilterSamples;
      this.renderer.compute(this.prefilterKernels[i]);
    }
  }

  measure(slot: number): void {
    if (!this.laneKernel || !this.reduceKernel) return;
    this.uStatsJob.value.set(slot, 0, 0, 0);
    this.uStatsLayout.value.set(this.resources.layout.faceSize, STATS_LANES, 0, 0);
    this.renderer.compute(this.laneKernel);
    this.renderer.compute(this.reduceKernel);
  }

  async readStats(): Promise<Float32Array> {
    return new Float32Array(await this.renderer.getArrayBufferAsync(this.resources.statsBuffer));
  }

  async readRadiance(): Promise<Float32Array> {
    return new Float32Array(await this.renderer.getArrayBufferAsync(this.resources.radianceBuffer));
  }

  async readRaw(): Promise<Float32Array> {
    return new Float32Array(await this.renderer.getArrayBufferAsync(this.resources.rawBuffer));
  }

  get captureDispatches(): number {
    return Math.ceil(this.resources.layout.baseTexels / this.sliceTexels);
  }
}
