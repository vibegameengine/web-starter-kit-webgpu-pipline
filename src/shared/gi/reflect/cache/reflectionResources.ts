import * as THREE from 'three/webgpu';
import { storage } from 'three/tsl';
import {
  PROXY_BOX,
  PROXY_SPHERE,
  SLOT_RECORD_VECS,
  faceLayout,
  reflectionMemory,
  type FaceLayout,
  type ReflectionMemory,
  type ReflectionVolume,
} from './reflectionTypes.ts';

export const RAW_VECS = 3;
export const STATS_LANES = 256;
export const STATS_VALUES = 4;

export const SLOT_STATE_EMPTY = 0;
export const SLOT_STATE_READABLE = 1;

export const FRESHNESS_CURRENT = 0;
export const FRESHNESS_STALE = 1;
export const FRESHNESS_OVERDUE = 2;

export interface SlotStatus {
  bank: number;
  state: number;
  slotGeneration: number;
  freshness: number;
}

export class ReflectionResources {
  readonly layout: FaceLayout;
  readonly memory: ReflectionMemory;
  readonly slots: number;

  private readonly rawAttribute: THREE.StorageBufferAttribute;
  private readonly radianceAttribute: THREE.StorageBufferAttribute;
  private readonly depthAttribute: THREE.StorageBufferAttribute;
  private readonly scratchAttribute: THREE.StorageBufferAttribute;
  private readonly tableAttribute: THREE.StorageBufferAttribute;
  private readonly laneAttribute: THREE.StorageBufferAttribute;
  private readonly statsAttribute: THREE.StorageBufferAttribute;

  readonly rawWrite: THREE.StorageBufferNode;
  readonly rawRead: THREE.StorageBufferNode;
  readonly radianceWrite: THREE.StorageBufferNode;
  readonly radianceRead: THREE.StorageBufferNode;
  readonly depthWrite: THREE.StorageBufferNode;
  readonly depthRead: THREE.StorageBufferNode;
  readonly scratchWrite: THREE.StorageBufferNode;
  readonly scratchRead: THREE.StorageBufferNode;
  readonly tableWrite: THREE.StorageBufferNode;
  readonly tableRead: THREE.StorageBufferNode;
  readonly laneWrite: THREE.StorageBufferNode;
  readonly laneRead: THREE.StorageBufferNode;
  readonly statsWrite: THREE.StorageBufferNode;

  private readonly tableData: Float32Array;

  constructor(faceSize: number, slots: number) {
    this.layout = faceLayout(faceSize);
    this.slots = slots;
    this.memory = reflectionMemory(this.layout, slots);
    const { baseTexels, chainTexels } = this.layout;

    this.rawAttribute = new THREE.StorageBufferAttribute(new Float32Array(slots * baseTexels * RAW_VECS * 4), 4);
    this.radianceAttribute = new THREE.StorageBufferAttribute(new Float32Array(2 * slots * chainTexels * 4), 4);
    this.depthAttribute = new THREE.StorageBufferAttribute(new Float32Array(2 * slots * baseTexels * 4), 4);
    this.scratchAttribute = new THREE.StorageBufferAttribute(new Float32Array(baseTexels * 4), 4);
    this.tableData = new Float32Array(slots * SLOT_RECORD_VECS * 4);
    this.tableAttribute = new THREE.StorageBufferAttribute(this.tableData, 4);
    this.laneAttribute = new THREE.StorageBufferAttribute(new Float32Array(STATS_LANES * 4), 4);
    this.statsAttribute = new THREE.StorageBufferAttribute(new Float32Array(STATS_VALUES), 1);

    const raw = slots * baseTexels * RAW_VECS;
    const radiance = 2 * slots * chainTexels;
    const depth = 2 * slots * baseTexels;
    this.rawWrite = storage(this.rawAttribute, 'vec4', raw).setName('reflRaw');
    this.rawRead = storage(this.rawAttribute, 'vec4', raw).toReadOnly().setName('reflRawRead');
    this.radianceWrite = storage(this.radianceAttribute, 'vec4', radiance).setName('reflRadiance');
    this.radianceRead = storage(this.radianceAttribute, 'vec4', radiance).toReadOnly().setName('reflRadianceRead');
    this.depthWrite = storage(this.depthAttribute, 'vec4', depth).setName('reflDepth');
    this.depthRead = storage(this.depthAttribute, 'vec4', depth).toReadOnly().setName('reflDepthRead');
    this.scratchWrite = storage(this.scratchAttribute, 'vec4', baseTexels).setName('reflScratch');
    this.scratchRead = storage(this.scratchAttribute, 'vec4', baseTexels).toReadOnly().setName('reflScratchRead');
    this.tableWrite = storage(this.tableAttribute, 'vec4', slots * SLOT_RECORD_VECS).setName('reflTable');
    this.tableRead = storage(this.tableAttribute, 'vec4', slots * SLOT_RECORD_VECS).toReadOnly().setName('reflTableRead');
    this.laneWrite = storage(this.laneAttribute, 'vec4', STATS_LANES).setName('reflLanes');
    this.laneRead = storage(this.laneAttribute, 'vec4', STATS_LANES).toReadOnly().setName('reflLanesRead');
    this.statsWrite = storage(this.statsAttribute, 'float', STATS_VALUES).setName('reflStats');
  }

  get statsBuffer(): THREE.StorageBufferAttribute {
    return this.statsAttribute;
  }

  get rawBuffer(): THREE.StorageBufferAttribute {
    return this.rawAttribute;
  }

  get radianceBuffer(): THREE.StorageBufferAttribute {
    return this.radianceAttribute;
  }

  get tableSnapshot(): Float32Array {
    return this.tableData;
  }

  writeSlotRecord(slot: number, volume: ReflectionVolume, status: SlotStatus): void {
    const { bank, state, slotGeneration, freshness } = status;
    const t = this.tableData;
    const o = slot * SLOT_RECORD_VECS * 4;
    const proxyKind = volume.proxy.kind === 'box' ? PROXY_BOX : PROXY_SPHERE;
    const center = volume.proxy.center;
    t[o + 0] = volume.anchor.x; t[o + 1] = volume.anchor.y; t[o + 2] = volume.anchor.z; t[o + 3] = volume.regionId;
    t[o + 4] = center.x; t[o + 5] = center.y; t[o + 6] = center.z; t[o + 7] = proxyKind;
    if (volume.proxy.kind === 'box') {
      t[o + 8] = volume.proxy.halfSize.x; t[o + 9] = volume.proxy.halfSize.y; t[o + 10] = volume.proxy.halfSize.z; t[o + 11] = 0;
    } else {
      t[o + 8] = volume.proxy.radius; t[o + 9] = volume.proxy.radius; t[o + 10] = volume.proxy.radius; t[o + 11] = volume.proxy.radius;
    }
    const own = volume.ownershipVolume;
    t[o + 12] = own.min.x; t[o + 13] = own.min.y; t[o + 14] = own.min.z; t[o + 15] = volume.priority;
    t[o + 16] = own.max.x; t[o + 17] = own.max.y; t[o + 18] = own.max.z; t[o + 19] = volume.id;
    const inf = volume.influenceVolume;
    t[o + 20] = inf.min.x; t[o + 21] = inf.min.y; t[o + 22] = inf.min.z; t[o + 23] = bank;
    t[o + 24] = inf.max.x; t[o + 25] = inf.max.y; t[o + 26] = inf.max.z; t[o + 27] = state;
    t[o + 28] = volume.faceSize; t[o + 29] = this.layout.levels; t[o + 30] = slotGeneration; t[o + 31] = freshness;
    this.tableAttribute.needsUpdate = true;
  }

  setSlotBank(slot: number, bank: number): void {
    this.tableData[slot * SLOT_RECORD_VECS * 4 + 23] = bank;
    this.tableAttribute.needsUpdate = true;
  }

  setSlotState(slot: number, state: number): void {
    this.tableData[slot * SLOT_RECORD_VECS * 4 + 27] = state;
    this.tableAttribute.needsUpdate = true;
  }

  setSlotFreshness(slot: number, freshness: number): void {
    this.tableData[slot * SLOT_RECORD_VECS * 4 + 31] = freshness;
    this.tableAttribute.needsUpdate = true;
  }

  dispose(): void {
    this.rawAttribute.array = new Float32Array(0);
    this.radianceAttribute.array = new Float32Array(0);
    this.depthAttribute.array = new Float32Array(0);
    this.scratchAttribute.array = new Float32Array(0);
  }
}
