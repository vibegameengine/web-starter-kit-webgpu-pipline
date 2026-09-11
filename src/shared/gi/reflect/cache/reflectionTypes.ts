import * as THREE from 'three/webgpu';

export type ProbeId = number;
export type RegionId = number;
export type Revision = number;
export type CaptureMode = 'stable' | 'live';
export type BuildState = 'empty' | 'capturing' | 'filtering' | 'completed' | 'failed';
export type Freshness = 'current' | 'stale' | 'overdue';
export type ReflectionMode = 'legacy' | 'cached';

export const PROXY_BOX = 0;
export const PROXY_SPHERE = 1;

export interface BoxProxy {
  kind: 'box';
  center: THREE.Vector3;
  halfSize: THREE.Vector3;
}

export interface SphereProxy {
  kind: 'sphere';
  center: THREE.Vector3;
  radius: number;
}

export interface ReflectionVolume {
  id: ProbeId;
  anchor: THREE.Vector3;
  regionId: RegionId;
  influenceVolume: THREE.Box3;
  ownershipVolume: THREE.Box3;
  proxy: BoxProxy | SphereProxy;
  priority: number;
  faceSize: number;
  captureMode: CaptureMode;
}

export interface PublishedProbe {
  probeId: ProbeId;
  slot: number;
  slotGeneration: number;
  bank: 0 | 1;
  captureRevision: Revision;
  lightingRevision: Revision;
  qualityEpoch: number;
  faceSize: number;
  capturedAtMs: number;
  publishedAtMs: number;
  invalidatedAtMs: number | null;
  freshness: Freshness;
}

export type CaptureFailure =
  | 'TRACE_LIMIT_REACHED'
  | 'QUALITY_LIMIT_REACHED'
  | 'UNSUPPORTED_MATERIAL'
  | 'INVALID_HDR'
  | 'SOURCE_MISSING';

export type PreparationError =
  | 'REFLECTION_VOLUME_UNCOVERED'
  | 'REFLECTION_MIXED_FACE_SIZE'
  | 'REFLECTION_BUDGET_EXCEEDED';

export type DebugView = 'off' | 'radiance' | 'owner' | 'freshness' | 'coverage' | 'spp' | 'footprint' | 'approximation';

export interface ReflectionCacheSettings {
  mode: ReflectionMode;
  enabled: boolean;
  gpuBudgetMiB: number;
  maxResidentProbes: number;
  bootstrapFaceSize: number;
  stableMinSamples: number;
  stableMaxSamples: number;
  liveFirstCheckpointSamples: number;
  prefilterSamples: number;
  visitTiers: readonly number[];
  maxStaleMs: number;
  maxEventToPublishMs: number;
  updateBudgetMs: number;
  wideBlendRoughness: number;
  maxFootprintTaps: number;
  intensity: number;
  freezeUpdates: boolean;
  skyKnee: number;
  depthCorrection: boolean;
  debugView: DebugView;
}

export const DEFAULT_REFLECTION_CACHE_SETTINGS: Readonly<ReflectionCacheSettings> = {
  mode: 'cached',
  enabled: true,
  gpuBudgetMiB: 192,
  maxResidentProbes: 4,
  bootstrapFaceSize: 32,
  stableMinSamples: 4,
  stableMaxSamples: 64,
  liveFirstCheckpointSamples: 1,
  prefilterSamples: 64,
  visitTiers: [8192, 32768, 131072],
  maxStaleMs: 50,
  maxEventToPublishMs: 50,
  updateBudgetMs: 2,
  wideBlendRoughness: 0.3,
  maxFootprintTaps: 8,
  intensity: 1,
  freezeUpdates: false,
  skyKnee: 5,
  depthCorrection: true,
  debugView: 'off',
};

export const DEBUG_VIEW_INDEX: readonly DebugView[] = ['off', 'owner', 'footprint', 'spp'];

export const QUALITY_CHECKPOINTS: readonly number[] = [4, 8, 16, 32, 64];

export const SLOT_RECORD_VECS = 8;

export interface FaceLayout {
  faceSize: number;
  levels: number;
  baseTexels: number;
  mipOffsets: readonly number[];
  chainTexels: number;
}

export function faceLayout(faceSize: number): FaceLayout {
  if (faceSize < 4 || (faceSize & (faceSize - 1)) !== 0) throw new Error(`reflection faceSize must be a power of two >= 4, got ${faceSize}`);
  const levels = Math.log2(faceSize) + 1;
  const offsets: number[] = [];
  let total = 0;
  for (let m = 0; m < levels; m++) {
    offsets.push(total);
    const side = faceSize >> m;
    total += 6 * side * side;
  }
  return { faceSize, levels, baseTexels: 6 * faceSize * faceSize, mipOffsets: offsets, chainTexels: total };
}

export function roughnessOfLevel(level: number, levels: number): number {
  return levels <= 1 ? 0 : level / (levels - 1);
}

export interface ReflectionMemory {
  rawBytes: number;
  radianceBytes: number;
  depthBytes: number;
  scratchBytes: number;
  tableBytes: number;
  totalBytes: number;
}

export function reflectionMemory(layout: FaceLayout, slots: number): ReflectionMemory {
  const rawBytes = slots * layout.baseTexels * 48;
  const radianceBytes = 2 * slots * layout.chainTexels * 16;
  const depthBytes = 2 * slots * layout.baseTexels * 16;
  const scratchBytes = layout.baseTexels * 16;
  const tableBytes = slots * SLOT_RECORD_VECS * 16;
  return {
    rawBytes,
    radianceBytes,
    depthBytes,
    scratchBytes,
    tableBytes,
    totalBytes: rawBytes + radianceBytes + depthBytes + scratchBytes + tableBytes,
  };
}

export function boxVolume(min: THREE.Vector3, max: THREE.Vector3): THREE.Box3 {
  return new THREE.Box3(min.clone(), max.clone());
}
