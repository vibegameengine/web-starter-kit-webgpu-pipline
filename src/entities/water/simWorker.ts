/// <reference lib="webworker" />
import * as THREE from 'three/webgpu';
import { Fn, exp, float, max, smoothstep, texture, uniform, uv, vec2, vec4 } from 'three/tsl';
import { ShallowWater } from './shallowWater.ts';
import type { WaterSimCost, WaterSimInit, WaterSimRequest, WaterSimResponse } from './waterSim.ts';

/**
 * The Kurganov–Petrova solver on its own thread and its own WebGPU device.
 *
 * Measured on the beach at 4K before this existed (2026-09-08, headed Chrome,
 * `scripts/_render_calls_probe.mjs` + `scripts/perf-passes.mjs`): the solver put
 * 25 quad renders of 384x384 into every main-thread frame — 12 + 12 SSP-RK2
 * stages and one view pass — for 0.37 ms GPU and **1.2 ms CPU** of the frame's
 * 8.3 ms budget. The GPU cost is small; the cost that mattered was a millisecond
 * of main-thread command encoding, and no scheduling trick removes that while
 * the passes are encoded by the frame's own renderer.
 *
 * Why not simply step the solver on its own frame schedule instead (the obvious
 * cheaper change): a decoupled schedule divides the cost by the stride but never
 * removes it — at every stride N the frame that does step still pays the whole
 * 1.2 ms, so the frame time gets a 1-in-N spike instead of a constant tax, which
 * is worse for a 8.3 ms budget than the tax was. Off-thread removes it from
 * every frame, spike included.
 *
 * WebGPU has no cross-device texture sharing, so the field cannot stay on the
 * GPU: the worker copies the (depth, u, v, foam) view — 384x384 RGBA16F,
 * 1 179 648 bytes — into a mapped buffer, transfers it to the main thread, and
 * the host uploads it into a DataTexture there. The buffers are recycled both
 * ways so the round trip allocates nothing after the first two frames.
 *
 * The solver's one input from the main thread was the sand's saturation (the
 * 1024² foam field's G, read by the Darcy infiltration sink). Sending an 8 MB
 * field back every frame would cost more than the solver did, and that channel
 * is a pure function of the solver's own depth — `max(standing, blurred previous
 * · exp(−dt/28))` — so the worker maintains it itself at the solver's own 384²,
 * with the blur radius kept in uv (0.6/1024) so it spreads over the same metres
 * as the main-thread field it stands in for.
 */

/** Matches the wetness (G) channel of the main thread's foam field in index.ts. */
class SandSaturation {
  readonly node: ReturnType<typeof texture>;
  private read: THREE.RenderTarget;
  private write: THREE.RenderTarget;
  private readonly quad: THREE.QuadMesh;
  private readonly dt = uniform(1 / 60);
  private readonly prev: ReturnType<typeof texture>;

  constructor(private readonly renderer: THREE.WebGPURenderer, size: number, depth: ReturnType<typeof texture>) {
    const make = () => {
      const target = new THREE.RenderTarget(size, size, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false,
      });
      target.texture.minFilter = target.texture.magFilter = THREE.LinearFilter;
      target.texture.wrapS = target.texture.wrapT = THREE.ClampToEdgeWrapping;
      return target;
    };
    this.read = make();
    this.write = make();
    this.prev = texture(this.read.texture);
    this.node = texture(this.read.texture);

    const material = new THREE.MeshBasicNodeMaterial();
    material.blending = THREE.NoBlending;
    material.depthTest = material.depthWrite = false;
    material.toneMapped = false;
    material.fragmentNode = Fn(() => {
      const q = uv();
      const standing = smoothstep(0.0005, 0.005, depth.sample(q).r);
      // Capillary spread and drainage, exactly as the foam field does it: the
      // offset is in uv, so the same metres of sand whatever the grid.
      const wt = float(0.6 / 1024);
      const blurred = this.prev.sample(q).g.mul(0.4)
        .add(this.prev.sample(q.add(vec2(wt, 0.0))).g.mul(0.15))
        .add(this.prev.sample(q.sub(vec2(wt, 0.0))).g.mul(0.15))
        .add(this.prev.sample(q.add(vec2(0.0, wt))).g.mul(0.15))
        .add(this.prev.sample(q.sub(vec2(0.0, wt))).g.mul(0.15));
      return vec4(0.0, max(standing, blurred.mul(exp(this.dt.negate().div(28.0)))), 0.0, 0.0);
    })();
    this.quad = new THREE.QuadMesh(material);
  }

  update(dt: number): void {
    this.dt.value = Math.min(0.05, Math.max(0.0005, dt));
    this.prev.value = this.read.texture;
    this.renderer.setRenderTarget(this.write);
    this.quad.render(this.renderer);
    const swap = this.read;
    this.read = this.write;
    this.write = swap;
    this.node.value = this.read.texture;
  }
}

/**
 * Copies a render target straight off the worker's device into a recycled mapped
 * buffer. Not `readRenderTargetPixelsAsync`: that allocates a fresh MAP_READ
 * buffer per call and returns the still-mapped range without ever destroying it,
 * which at 60 Hz is 70 MB/s of leaked GPU buffers.
 *
 * `submit` encodes the copy and returns before the fence: measured 2026-09-08 on
 * the beach, awaiting `mapAsync` inside the tick let a single map take 3 530 ms
 * while the main thread's own device kept the GPU busy, and the solver fell to
 * ~3 ticks/s — the water ran 40x slow. The fence latency is the main device's,
 * not the solver's, so the solver must never be inside it.
 */
class FieldReadback {
  private readonly free: GPUBuffer[] = [];
  private readonly bytesPerRow: number;
  private readonly bytes: number;

  constructor(private readonly renderer: THREE.WebGPURenderer, private readonly size: number) {
    this.bytesPerRow = size * 8;
    if (this.bytesPerRow % 256 !== 0) throw new Error(`water field row ${this.bytesPerRow} B is not 256-aligned`);
    this.bytes = this.bytesPerRow * size;
  }

  /** True while a copy is encoded and its fence has not come back yet. */
  get busy(): boolean {
    return this.inFlight > 0;
  }

  private inFlight = 0;

  submit(target: THREE.RenderTarget, into: Uint16Array, done: (field: Uint16Array, waitMs: number) => void): void {
    const backend = this.renderer.backend as unknown as { device: GPUDevice; get(o: object): { texture: GPUTexture } };
    const device = backend.device;
    const buffer = this.free.pop() ?? device.createBuffer({ size: this.bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: backend.get(target.texture).texture, origin: { x: 0, y: 0, z: 0 } },
      { buffer, bytesPerRow: this.bytesPerRow },
      { width: this.size, height: this.size },
    );
    device.queue.submit([encoder.finish()]);
    this.inFlight++;
    const submitted = performance.now();
    void buffer.mapAsync(GPUMapMode.READ).then(() => {
      into.set(new Uint16Array(buffer.getMappedRange()));
      buffer.unmap();
      this.free.push(buffer);
      this.inFlight--;
      done(into, performance.now() - submitted);
    });
  }
}

const post = (message: WaterSimResponse, transfer: Transferable[] = []) => self.postMessage(message, transfer);
const bedTexture = (data: Uint16Array, size: number) => {
  const map = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  map.minFilter = map.magFilter = THREE.LinearFilter;
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
  map.generateMipmaps = false;
  map.needsUpdate = true;
  return map;
};

let sim: ShallowWater | null = null;
let saturation: SandSaturation | null = null;
let readback: FieldReadback | null = null;
let renderer: THREE.WebGPURenderer | null = null;
let running = true;
let scheduled = false;
let lastTick = 0;
let lastWait = 0;
let cost: WaterSimCost = { step: 0, saturation: 0, readback: 0, hz: 0, rate: 0 };
const window1s = { at: 0, ticks: 0, step: 0, saturation: 0, simTime: 0 };
const spare: Uint16Array[] = [];

async function boot(init: WaterSimInit): Promise<void> {
  renderer = new THREE.WebGPURenderer({ canvas: init.canvas as unknown as HTMLCanvasElement, antialias: false });
  await renderer.init();
  sim = new ShallowWater({
    renderer, bathymetry: bedTexture(init.bathymetry, init.bathymetrySize), half: init.half,
    waterLevel: init.waterLevel, size: init.size, faceDepth: init.faceDepth,
  });
  sim.swellAmplitude.value = init.swellAmplitude;
  sim.swellPeriod.value = init.swellPeriod;
  sim.manning.value = init.manning;
  sim.setSwellDirection(init.swellDirection);
  saturation = new SandSaturation(renderer, init.size, sim.stateNode);
  sim.setSaturation(saturation.node.value as THREE.Texture);
  readback = new FieldReadback(renderer, init.size);
  // The preroll is 6 s of water at a 1.5 ms step — 4000 sub-steps, 8000 quad
  // renders. On the main thread that was a second of boot nobody could use.
  sim.preroll(init.prerollSeconds);
  saturation.update(1 / 60);
  post({ type: 'ready', simTime: sim.simTime });
  lastTick = performance.now();
  schedule();
}

/** The solver's own clock: 60 Hz, independent of the main thread's frame rate. */
const TICK_MS = 1000 / 60;

function schedule(): void {
  if (scheduled || !running) return;
  scheduled = true;
  setTimeout(() => { scheduled = false; tick(); }, Math.max(0, TICK_MS - (performance.now() - lastTick)));
}

function tick(): void {
  if (!running || !sim || !saturation || !readback) return;
  const now = performance.now();
  const dt = Math.min(0.05, Math.max(0.001, (now - lastTick) / 1000));
  lastTick = now;
  sim.step(dt);
  const stepped = performance.now();
  saturation.update(dt);
  sim.setSaturation(saturation.node.value as THREE.Texture);
  const wetted = performance.now();
  // One copy in flight at a time: a second would only carry a field the main
  // thread is going to drop anyway, and it doubles the mapped memory.
  if (!readback.busy) {
    const buffer = spare.pop() ?? new Uint16Array(sim.size * sim.size * 4);
    const at = sim.simTime;
    readback.submit(sim.viewTarget, buffer, (field, waitMs) => {
      lastWait = waitMs;
      post({ type: 'field', field, simTime: at, cost: { ...cost, readback: waitMs } }, [field.buffer]);
    });
  }
  accumulate(now, stepped - now, wetted - stepped, sim.simTime);
  schedule();
}

/** Rolling one-second averages: a single tick says nothing about whether the water keeps up. */
function accumulate(now: number, step: number, saturation: number, simTime: number): void {
  window1s.ticks++;
  window1s.step += step;
  window1s.saturation += saturation;
  const span = now - window1s.at;
  if (span < 1000) return;
  cost = {
    step: window1s.step / window1s.ticks,
    saturation: window1s.saturation / window1s.ticks,
    readback: lastWait,
    hz: (window1s.ticks * 1000) / span,
    rate: (simTime - window1s.simTime) / (span / 1000),
  };
  window1s.at = now;
  window1s.ticks = 0;
  window1s.step = 0;
  window1s.saturation = 0;
  window1s.simTime = simTime;
}

async function answer(request: Extract<WaterSimRequest, { type: 'read' }>): Promise<void> {
  if (!sim) return;
  if (request.what === 'state') post({ type: 'read', id: request.id, value: await sim.readState() });
  else if (request.what === 'stats') post({ type: 'read', id: request.id, value: await sim.readStats() });
  else if (request.what === 'probe') post({ type: 'read', id: request.id, value: await sim.readProbe() });
  else post({ type: 'read', id: request.id, value: await sim.readRow(request.row ?? 0) });
}

self.onmessage = async (event: MessageEvent<WaterSimRequest>) => {
  const message = event.data;
  try {
    if (message.type === 'init') await boot(message.init);
    else if (message.type === 'recycle') spare.push(message.field);
    else if (message.type === 'read') await answer(message);
    else if (message.type === 'running') {
      running = message.running;
      lastTick = performance.now();
      if (running) schedule();
    } else if (message.type === 'params' && sim) {
      sim.swellAmplitude.value = message.params.swellAmplitude;
      sim.swellPeriod.value = message.params.swellPeriod;
      sim.manning.value = message.params.manning;
      sim.setSwellDirection(message.params.swellDirection);
    }
  } catch (error) {
    post({ type: 'error', message: String((error as Error)?.stack ?? error) });
  }
};
