import * as THREE from 'three/webgpu';
import { texture, uniform, vec2 } from 'three/tsl';
import type {
  WaterSim, WaterSimCost, WaterSimInit, WaterSimParams, WaterSimProbe, WaterSimRequest, WaterSimResponse, WaterSimState,
} from './waterSim.ts';

/**
 * The main thread's half of the off-thread solver (see simWorker.ts for the
 * measurement that motivates it and for why frame-decoupling was rejected).
 *
 * Nothing here encodes a solver pass. Each frame `step` does two things: push any
 * uniform the GUI moved, and — if the worker has posted a new field — hand its
 * buffer to a DataTexture and mark it for upload. The buffer is swapped, never
 * copied, and the retired one goes back to the worker to be filled again, so the
 * per-frame main-thread work is one `queue.writeTexture` of 1.15 MiB.
 *
 * The field arrives one to two frames late. At 60 Hz that is 16–33 ms of lag on
 * water whose own swell period is 3.2 s; the surface is drawn from the same field
 * everywhere, so nothing comes apart — it is the whole lagoon that is a frame
 * behind the camera, which is not visible.
 */
export interface WorkerWaterSimOptions {
  renderer: THREE.WebGPURenderer;
  /** The baked bed. Read back off the main device once, then owned by the worker. */
  bathymetry: THREE.Texture;
  half: number;
  waterLevel: number;
  size: number;
  faceDepth: { x: number; z: number };
  swellAmplitude: number;
  swellPeriod: number;
  swellDirection: number;
  prerollSeconds: number;
}

export class WorkerWaterSim implements WaterSim {
  readonly size: number;
  readonly cell: number;
  readonly stateNode: ReturnType<typeof texture>;
  readonly swellAmplitude: ReturnType<typeof uniform>;
  readonly swellPeriod: ReturnType<typeof uniform>;
  readonly manning = uniform(0.025);
  /** Resolves when the worker's device is up and its preroll is done. */
  readonly ready: Promise<void>;
  readonly firstFieldReady: Promise<void>;
  readonly bootTimings: Record<string, number> = {};
  private readonly createdAt = performance.now();

  private readonly worker: Worker;
  private readonly half: number;
  private readonly field: THREE.DataTexture;
  private pending: Uint16Array | null = null;
  private _simTime = 0;
  /** Audit only: what the worker's last tick spent, and how many it has run. */
  cost: WaterSimCost & { fields: number } = { step: 0, saturation: 0, readback: 0, hz: 0, rate: 0, fields: 0 };
  private swellDirection: number;
  private sent: WaterSimParams;
  private readonly waiting = new Map<number, (value: unknown) => void>();
  private nextId = 1;

  constructor(options: WorkerWaterSimOptions) {
    this.size = options.size;
    this.half = options.half;
    this.cell = (2 * options.half) / options.size;
    this.swellAmplitude = uniform(options.swellAmplitude);
    this.swellPeriod = uniform(options.swellPeriod);
    this.swellDirection = options.swellDirection;
    this.sent = { swellAmplitude: options.swellAmplitude, swellPeriod: options.swellPeriod, manning: 0.025, swellDirection: options.swellDirection };

    // A lake at rest until the worker's first field lands: depth 0 everywhere is
    // the dry bed, which is what the surface already draws outside the lagoon.
    this.field = new THREE.DataTexture(new Uint16Array(this.size * this.size * 4), this.size, this.size, THREE.RGBAFormat, THREE.HalfFloatType);
    this.field.name = 'waterSimField';
    this.field.minFilter = this.field.magFilter = THREE.LinearFilter;
    this.field.wrapS = this.field.wrapT = THREE.ClampToEdgeWrapping;
    this.field.generateMipmaps = false;
    this.field.needsUpdate = true;
    this.stateNode = texture(this.field);

    this.worker = new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module', name: 'waterSim' });
    this.worker.onerror = (event) => console.error('[waterSim worker]', event.message);
    let resolveReady: () => void = () => {};
    let resolveFirstField: () => void = () => {};
    this.ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    this.firstFieldReady = new Promise<void>((resolve) => { resolveFirstField = resolve; });
    this.worker.onmessage = (event: MessageEvent<WaterSimResponse>) => this.receive(event.data, resolveReady, resolveFirstField);
    void this.launch(options);
  }

  private receive(message: WaterSimResponse, resolveReady: () => void, resolveFirstField: () => void): void {
    if (message.type === 'field') {
      if (this.cost.fields === 0) this.bootTimings.firstField = performance.now() - this.createdAt;
      // Only the newest field is worth uploading; a frame the renderer never drew
      // goes straight back to the worker as a spare buffer.
      if (this.pending) this.worker.postMessage({ type: 'recycle', field: this.pending } satisfies WaterSimRequest, [this.pending.buffer]);
      this.pending = message.field;
      this._simTime = message.simTime;
      this.cost = { ...message.cost, fields: this.cost.fields + 1 };
      resolveFirstField();
    } else if (message.type === 'ready') {
      Object.assign(this.bootTimings, message.bootTimings);
      this.bootTimings.workerReady = performance.now() - this.createdAt;
      this._simTime = message.simTime;
      resolveReady();
    } else if (message.type === 'read') {
      this.waiting.get(message.id)?.(message.value);
      this.waiting.delete(message.id);
    } else if (message.type === 'error') {
      console.error('[waterSim worker]', message.message);
    }
  }

  private async launch(options: WorkerWaterSimOptions): Promise<void> {
    const source = options.bathymetry.userData.renderTarget as THREE.RenderTarget | undefined;
    if (!source) throw new Error('waterSim: the bathymetry texture carries no render target to read back');
    const raw = await options.renderer.readRenderTargetPixelsAsync(source, 0, 0, source.width, source.height);
    const bathymetry = new Uint16Array(raw as unknown as Uint16Array);
    const init: WaterSimInit = {
      canvas: new OffscreenCanvas(4, 4), bathymetry, bathymetrySize: source.width, half: options.half,
      waterLevel: options.waterLevel, size: options.size, faceDepth: options.faceDepth,
      prerollSeconds: options.prerollSeconds, swellAmplitude: options.swellAmplitude,
      swellPeriod: options.swellPeriod, manning: this.manning.value as number, swellDirection: options.swellDirection,
    };
    this.worker.postMessage({ type: 'init', init } satisfies WaterSimRequest, [init.canvas, bathymetry.buffer]);
    this.bootTimings.bathymetryReadback = performance.now() - this.createdAt;
  }

  setSwellDirection(radians: number): void {
    this.swellDirection = radians;
  }

  /** The worker keeps its own saturation field; the main thread's foam field is not sent. */
  setSaturation(): void {}

  setRunning(running: boolean): void {
    this.worker.postMessage({ type: 'running', running } satisfies WaterSimRequest);
  }

  get simTime(): number {
    return this._simTime;
  }

  get timeStep(): number {
    return 0.0015;
  }

  uvOf(xz: THREE.Node): THREE.Node {
    return (xz as ReturnType<typeof vec2>).div(this.half * 2).add(0.5);
  }

  step(): void {
    const params: WaterSimParams = {
      swellAmplitude: this.swellAmplitude.value as number,
      swellPeriod: this.swellPeriod.value as number,
      manning: this.manning.value as number,
      swellDirection: this.swellDirection,
    };
    const changed = (Object.keys(params) as (keyof WaterSimParams)[]).some((key) => params[key] !== this.sent[key]);
    if (changed) {
      this.sent = params;
      this.worker.postMessage({ type: 'params', params } satisfies WaterSimRequest);
    }
    if (!this.pending) return;
    const retired = this.field.image.data as Uint16Array;
    this.field.image.data = this.pending;
    this.field.needsUpdate = true;
    this.pending = null;
    this.worker.postMessage({ type: 'recycle', field: retired } satisfies WaterSimRequest, [retired.buffer]);
  }

  private request<T>(what: 'state' | 'stats' | 'probe' | 'row', row?: number): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve) => {
      this.waiting.set(id, resolve as (value: unknown) => void);
      this.worker.postMessage({ type: 'read', id, what, row } satisfies WaterSimRequest);
    });
  }

  readState(): Promise<WaterSimState> { return this.request<WaterSimState>('state'); }
  readStats(): Promise<Record<string, number>> { return this.request<Record<string, number>>('stats'); }
  readRow(j: number): Promise<Float32Array> { return this.request<Float32Array>('row', j); }
  readProbe(): Promise<WaterSimProbe> { return this.request<WaterSimProbe>('probe'); }
}
