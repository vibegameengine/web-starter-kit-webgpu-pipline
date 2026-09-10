import type * as THREE from 'three/webgpu';
import type { texture, uniform } from 'three/tsl';

/**
 * What the water's consumers need of the solver, whichever thread it runs on:
 * `ShallowWater` (this thread, `?waterSim=main`) and `WorkerWaterSim`
 * (simWorker.ts on its own WebGPU device, the default) both satisfy it.
 *
 * See docs/water/knowledge-base.md and the header of simWorker.ts for why the
 * off-thread solver exists and what it costs.
 */
export interface WaterSim {
  /** Cells across the slab. */
  readonly size: number;
  /** Metres per cell. */
  readonly cell: number;
  /** (depth, u, v, foam source) as the renderer reads it. */
  readonly stateNode: ReturnType<typeof texture>;
  readonly swellAmplitude: ReturnType<typeof uniform>;
  readonly swellPeriod: ReturnType<typeof uniform>;
  readonly manning: ReturnType<typeof uniform>;
  /** Seconds of water simulated so far — the clock everything downstream runs on. */
  readonly simTime: number;
  /** The fixed sub-step, seconds. */
  readonly timeStep: number;
  setSwellDirection(radians: number): void;
  setSaturation(field: THREE.Texture): void;
  /** Texture uv of a world (x, z) on the slab. */
  uvOf(xz: THREE.Node): THREE.Node;
  /** Advances the water by `dt` seconds of wall time (off-thread: collects what is ready). */
  step(dt: number): void;
  /** Stops and restarts the solver without losing its state (off-thread only). */
  setRunning?(running: boolean): void;
  readState(): Promise<WaterSimState>;
  readStats(): Promise<Record<string, number>>;
  readRow(j: number): Promise<Float32Array>;
  readProbe(): Promise<WaterSimProbe>;
}

export interface WaterSimState {
  size: number;
  depth: Float32Array;
  u: Float32Array;
  v: Float32Array;
  foam: Float32Array;
}

export interface WaterSimProbe {
  wMin: number;
  wMax: number;
  huMax: number;
  huMin: number;
  faceW: number[];
  rowW: number[];
}

/** Everything the worker needs to build the same solver this thread would have built. */
export interface WaterSimInit {
  canvas: OffscreenCanvas;
  /** The baked bed, read back off the main device once: RGBA16F, R = height in metres. */
  bathymetry: Uint16Array;
  bathymetrySize: number;
  half: number;
  waterLevel: number;
  size: number;
  faceDepth: { x: number; z: number };
  prerollSeconds: number;
  swellAmplitude: number;
  swellPeriod: number;
  manning: number;
  swellDirection: number;
}

/** What one worker tick spent, milliseconds — reported to the audit hook, not used by the render. */
export interface WaterSimCost {
  /** Mean ms encoding the solver's passes, over the last second. */
  step: number;
  /** Mean ms encoding the saturation pass, over the last second. */
  saturation: number;
  /** Fence latency of the last field copy, ms — off the solver's critical path. */
  readback: number;
  /** Solver ticks per second the worker actually achieved over the last second. */
  hz: number;
  /** Seconds of water simulated per second of wall time (1 = real time). */
  rate: number;
}

export interface WaterSimParams {
  swellAmplitude: number;
  swellPeriod: number;
  manning: number;
  swellDirection: number;
}

/** Main thread → worker. */
export type WaterSimRequest =
  | { type: 'init'; init: WaterSimInit }
  | { type: 'params'; params: WaterSimParams }
  | { type: 'running'; running: boolean }
  | { type: 'recycle'; field: Uint16Array }
  | { type: 'read'; id: number; what: 'state' | 'stats' | 'probe' | 'row'; row?: number };

/** Worker → main thread. */
export type WaterSimResponse =
  | { type: 'ready'; simTime: number; bootTimings?: Record<string, number> }
  | { type: 'field'; field: Uint16Array; simTime: number; cost: WaterSimCost }
  | { type: 'read'; id: number; value: unknown }
  | { type: 'error'; message: string };
