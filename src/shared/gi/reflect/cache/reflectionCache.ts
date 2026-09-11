import * as THREE from 'three/webgpu';
import { ReflectionPasses, type CaptureSources } from './reflectionPasses.ts';
import {
  FRESHNESS_CURRENT,
  FRESHNESS_OVERDUE,
  FRESHNESS_STALE,
  RAW_VECS,
  ReflectionResources,
  SLOT_STATE_EMPTY,
  SLOT_STATE_READABLE,
} from './reflectionResources.ts';
import { ReflectionSampler } from './reflectionSampler.ts';
import {
  DEBUG_VIEW_INDEX,
  DEFAULT_REFLECTION_CACHE_SETTINGS,
  QUALITY_CHECKPOINTS,
  reflectionMemory,
  type CaptureFailure,
  type PreparationError,
  type ReflectionCacheSettings,
  type ReflectionVolume,
} from './reflectionTypes.ts';

interface ProbeRuntime {
  volume: ReflectionVolume;
  slot: number;
  slotGeneration: number;
  activeBank: number;
  state: 'empty' | 'capturing' | 'filtering' | 'completed' | 'failed';
  cursor: number;
  sweeps: number;
  tier: number;
  sampleTarget: number;
  measuredMinCount: number;
  measuredCoverage: number;
  measuredDepthCoverage: number;
  lastMinCount: number;
  stalledSweeps: number;
  statsPending: boolean;
  captureRevision: number;
  requiredRevision: number;
  publishedRevision: number;
  capturedAtMs: number;
  publishedAtMs: number;
  invalidatedAtMs: number | null;
  firstUnservedEventAt: number | null;
  failure: CaptureFailure | null;
}

export interface ReflectionCounters {
  traceDispatches: number;
  filterDispatches: number;
  publications: number;
  sweeps: number;
  minSpp: number;
  coverage: number;
  overdueFrames: number;
  missingLocalFrames: number;
  staleAgeMs: number;
  eventToPublishMs: number;
}

export class ReflectionCache {
  readonly settings: ReflectionCacheSettings;
  readonly resources: ReflectionResources;
  readonly sampler: ReflectionSampler;
  readonly errors: PreparationError[] = [];
  private readonly passes: ReflectionPasses;
  private readonly probes: ProbeRuntime[] = [];
  private readonly counters: ReflectionCounters = {
    traceDispatches: 0,
    filterDispatches: 0,
    publications: 0,
    sweeps: 0,
    minSpp: 0,
    coverage: 0,
    overdueFrames: 0,
    missingLocalFrames: 0,
    staleAgeMs: 0,
    eventToPublishMs: 0,
  };
  private slicesPerFrame = 2;

  constructor(
    renderer: THREE.WebGPURenderer,
    volumes: readonly ReflectionVolume[],
    sources: CaptureSources,
    settings: Partial<ReflectionCacheSettings> = {},
  ) {
    this.settings = { ...DEFAULT_REFLECTION_CACHE_SETTINGS, ...settings };
    const sizes = new Set(volumes.map((volume) => volume.faceSize));
    if (sizes.size > 1) this.errors.push('REFLECTION_MIXED_FACE_SIZE');
    const faceSize = volumes.length > 0 ? volumes[0].faceSize : 128;
    const slots = Math.max(1, Math.min(this.settings.maxResidentProbes, Math.max(1, volumes.length)));
    this.resources = new ReflectionResources(faceSize, slots);
    const budgetBytes = this.settings.gpuBudgetMiB * 1024 * 1024;
    if (this.resources.memory.totalBytes > budgetBytes) this.errors.push('REFLECTION_BUDGET_EXCEEDED');
    this.passes = new ReflectionPasses(renderer, this.resources, sources, 16384);
    this.sampler = new ReflectionSampler(this.resources);
    this.sampler.intensity.value = this.settings.intensity;
    this.sampler.wideBlendRoughness.value = this.settings.wideBlendRoughness;
    this.sampler.depthCorrection.value = this.settings.depthCorrection ? 1 : 0;
    this.sampler.maxTaps.value = this.settings.maxFootprintTaps;
    this.sampler.debugMode.value = DEBUG_VIEW_INDEX.indexOf(this.settings.debugView);
    for (let i = 0; i < Math.min(volumes.length, slots); i++) this.install(volumes[i], i);
  }

  private install(volume: ReflectionVolume, slot: number): void {
    const probe: ProbeRuntime = {
      volume,
      slot,
      slotGeneration: 1,
      activeBank: 1,
      state: 'capturing',
      cursor: 0,
      sweeps: 0,
      tier: 0,
      sampleTarget: this.firstCheckpoint(volume),
      measuredMinCount: 0,
      measuredCoverage: 0,
      measuredDepthCoverage: 0,
      lastMinCount: -1,
      stalledSweeps: 0,
      statsPending: false,
      captureRevision: 1,
      requiredRevision: 1,
      publishedRevision: 0,
      capturedAtMs: 0,
      publishedAtMs: 0,
      invalidatedAtMs: null,
      firstUnservedEventAt: null,
      failure: null,
    };
    this.probes.push(probe);
    this.resources.writeSlotRecord(slot, volume, {
      bank: probe.activeBank,
      state: SLOT_STATE_EMPTY,
      slotGeneration: probe.slotGeneration,
      freshness: FRESHNESS_CURRENT,
    });
  }

  private firstCheckpoint(volume: ReflectionVolume): number {
    if (volume.captureMode === 'live') return this.settings.liveFirstCheckpointSamples;
    return Math.max(1, this.settings.stableMinSamples);
  }

  private nextCheckpoint(current: number): number {
    for (const checkpoint of QUALITY_CHECKPOINTS) {
      if (checkpoint > current && checkpoint <= this.settings.stableMaxSamples) return checkpoint;
    }
    return current;
  }

  get counterSnapshot(): ReflectionCounters {
    return { ...this.counters };
  }

  get memoryReport(): string {
    const memory = reflectionMemory(this.resources.layout, this.resources.slots);
    const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
    return `raw ${mib(memory.rawBytes)} + radiance ${mib(memory.radianceBytes)} + depth ${mib(memory.depthBytes)}`
      + ` + scratch ${mib(memory.scratchBytes)} = ${mib(memory.totalBytes)} MiB`;
  }

  get probeStates(): { id: number; state: string; spp: number; coverage: number; bank: number; revision: number }[] {
    return this.probes.map((probe) => ({
      id: probe.volume.id,
      state: probe.state,
      spp: probe.measuredMinCount,
      coverage: probe.measuredCoverage,
      bank: probe.activeBank,
      revision: probe.publishedRevision,
    }));
  }

  invalidate(now: number): void {
    for (const probe of this.probes) {
      probe.requiredRevision += 1;
      probe.captureRevision = probe.requiredRevision;
      if (probe.invalidatedAtMs === null) probe.invalidatedAtMs = now;
      if (probe.firstUnservedEventAt === null) probe.firstUnservedEventAt = now;
      probe.state = 'capturing';
      probe.cursor = 0;
      probe.sweeps = 0;
      probe.lastMinCount = -1;
      probe.stalledSweeps = 0;
      probe.sampleTarget = this.firstCheckpoint(probe.volume);
      probe.measuredMinCount = 0;
      this.clearRaw(probe.slot);
      if (probe.publishedRevision > 0) this.resources.setSlotFreshness(probe.slot, FRESHNESS_STALE);
    }
  }

  private clearRaw(slot: number): void {
    const { baseTexels } = this.resources.layout;
    const array = this.resources.rawBuffer.array as Float32Array;
    array.fill(0, slot * baseTexels * RAW_VECS * 4, (slot + 1) * baseTexels * RAW_VECS * 4);
    this.resources.rawBuffer.needsUpdate = true;
  }

  update(now: number, envIntensity: number, dynamicEnabled: boolean): void {
    this.counters.minSpp = this.probes.length > 0 ? Math.min(...this.probes.map((probe) => probe.measuredMinCount)) : 0;
    this.counters.coverage = this.probes.length > 0 ? Math.min(...this.probes.map((probe) => probe.measuredCoverage)) : 0;
    this.counters.missingLocalFrames += this.probes.some((probe) => probe.publishedRevision === 0) ? 1 : 0;
    this.updateFreshness(now);
    if (!this.settings.enabled || this.settings.freezeUpdates) return;
    for (const probe of this.probes) {
      if (probe.state !== 'capturing') continue;
      this.passes.syncLighting(probe.volume.anchor, envIntensity, this.settings.skyKnee, dynamicEnabled);
      this.serviceProbe(probe, now);
      break;
    }
  }

  private updateFreshness(now: number): void {
    for (const probe of this.probes) {
      if (probe.publishedRevision === 0) continue;
      if (probe.invalidatedAtMs === null) {
        this.resources.setSlotFreshness(probe.slot, FRESHNESS_CURRENT);
        continue;
      }
      const age = now - probe.invalidatedAtMs;
      this.counters.staleAgeMs = Math.max(this.counters.staleAgeMs, age);
      if (age > this.settings.maxStaleMs) {
        this.resources.setSlotFreshness(probe.slot, FRESHNESS_OVERDUE);
        this.counters.overdueFrames += 1;
      } else {
        this.resources.setSlotFreshness(probe.slot, FRESHNESS_STALE);
      }
    }
  }

  private serviceProbe(probe: ProbeRuntime, now: number): void {
    const { baseTexels } = this.resources.layout;
    const backBank = 1 - probe.activeBank;
    const visitCap = this.settings.visitTiers[Math.min(probe.tier, this.settings.visitTiers.length - 1)];
    for (let slice = 0; slice < this.slicesPerFrame; slice++) {
      this.passes.capture({
        base: probe.cursor,
        count: this.passes.sliceTexels,
        slot: probe.slot,
        backBank,
        sampleTarget: probe.sampleTarget,
        visitCap,
        sampleStride: 1,
      });
      this.counters.traceDispatches += 1;
      probe.cursor += this.passes.sliceTexels;
      if (probe.cursor >= baseTexels) {
        probe.cursor = 0;
        probe.sweeps += 1;
        this.counters.sweeps += 1;
        this.requestStats(probe, now);
        break;
      }
    }
  }

  private requestStats(probe: ProbeRuntime, now: number): void {
    if (probe.statsPending) return;
    probe.statsPending = true;
    this.passes.measure(probe.slot);
    void this.passes.readStats().then((stats) => {
      probe.statsPending = false;
      probe.measuredMinCount = stats[0] >= 1e8 ? 0 : stats[0];
      probe.measuredCoverage = stats[1] / this.resources.layout.baseTexels;
      probe.measuredDepthCoverage = stats[2] / this.resources.layout.baseTexels;
      this.onStats(probe, now);
    });
  }

  private onStats(probe: ProbeRuntime, now: number): void {
    if (probe.state !== 'capturing') return;
    if (probe.measuredMinCount <= probe.lastMinCount) {
      probe.stalledSweeps += 1;
      if (probe.stalledSweeps >= 2) {
        if (probe.tier < this.settings.visitTiers.length - 1) {
          probe.tier += 1;
          probe.stalledSweeps = 0;
        } else {
          probe.state = 'failed';
          probe.failure = 'TRACE_LIMIT_REACHED';
          console.warn(`[reflections] probe ${probe.volume.id} stopped at ${probe.measuredMinCount} spp: TRACE_LIMIT_REACHED`);
          return;
        }
      }
    } else {
      probe.stalledSweeps = 0;
    }
    probe.lastMinCount = probe.measuredMinCount;
    if (probe.measuredMinCount < probe.sampleTarget) return;
    if (probe.measuredDepthCoverage < 1) return;
    this.publish(probe, now);
  }

  private publish(probe: ProbeRuntime, now: number): void {
    const backBank = 1 - probe.activeBank;
    probe.state = 'filtering';
    this.passes.freezeAndFilter(probe.slot, backBank, this.settings.prefilterSamples);
    this.counters.filterDispatches += 1 + this.resources.layout.levels;
    probe.activeBank = backBank;
    probe.publishedRevision = probe.captureRevision;
    probe.capturedAtMs = now;
    probe.publishedAtMs = now;
    if (probe.firstUnservedEventAt !== null) {
      this.counters.eventToPublishMs = Math.max(this.counters.eventToPublishMs, now - probe.firstUnservedEventAt);
      probe.firstUnservedEventAt = null;
    }
    probe.invalidatedAtMs = null;
    this.resources.setSlotBank(probe.slot, probe.activeBank);
    this.resources.setSlotState(probe.slot, SLOT_STATE_READABLE);
    this.resources.setSlotFreshness(probe.slot, FRESHNESS_CURRENT);
    this.counters.publications += 1;
    const next = this.nextCheckpoint(probe.sampleTarget);
    if (next > probe.sampleTarget) {
      probe.sampleTarget = next;
      probe.state = 'capturing';
      probe.lastMinCount = -1;
    } else {
      probe.state = 'completed';
    }
  }

  async dump(): Promise<Record<string, unknown>> {
    const { layout, slots } = this.resources;
    const radiance = await this.passes.readRadiance();
    const raw = await this.passes.readRaw();
    const probe = this.probes[0];
    const mean = (array: Float32Array, start: number, texels: number, stride: number) => {
      let sum = 0;
      let nonZero = 0;
      for (let i = 0; i < texels; i++) {
        const value = array[start + i * stride] + array[start + i * stride + 1] + array[start + i * stride + 2];
        sum += value;
        if (value > 0) nonZero++;
      }
      return { mean: sum / Math.max(1, texels), nonZero: nonZero / Math.max(1, texels) };
    };
    const bankStart = (probe.activeBank * slots + probe.slot) * layout.chainTexels * 4;
    return {
      activeBank: probe.activeBank,
      state: probe.state,
      base: mean(radiance, bankStart, layout.baseTexels, 4),
      topMip: mean(radiance, bankStart + layout.mipOffsets[layout.levels - 1] * 4, 6, 4),
      raw: mean(raw, probe.slot * layout.baseTexels * 12, layout.baseTexels, 12),
      table: Array.from(this.resources.tableSnapshot.slice(0, 32)).map((v) => +v.toFixed(3)),
    };
  }

  dispose(): void {
    this.resources.dispose();
  }
}
