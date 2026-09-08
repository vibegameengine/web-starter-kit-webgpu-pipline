import * as THREE from 'three/webgpu';
import { Fn, dFdx, dFdy, texture, uniform, vec2, vec4, sampler, wgslFn } from 'three/tsl';
import { pageId, type LightmapPageKey, type LightmapPageSource } from './lightmapPages.ts';
import { virtualFootprint } from './filterFootprint';

export interface PageDemand { key: LightmapPageKey; priority: number }
interface Resident { key: LightmapPageKey; slot: number; lastUsed: number }
interface ReadyPage { key: LightmapPageKey; data: Float32Array; generation: number }

/** A bounded GPU working set. Light computation stays in Webgiya's baker. */
export class VirtualLightmap {
  readonly fallback: THREE.DataTexture;
  readonly enabled = uniform(1);
  readonly anisotropy = uniform(8);
  private readonly clockMs = uniform(0);
  private readonly physical: THREE.DataArrayTexture;
  private readonly staging: THREE.DataTexture;
  private readonly table: THREE.DataTexture;
  private readonly tableData: Uint32Array;
  private readonly rows: number[] = [];
  private readonly resident = new Map<string, Resident>();
  private readonly pending = new Map<string, AbortController>();
  private readonly failed = new Map<string, { attempts: number; retryAt: number }>();
  private readonly ready: ReadyPage[] = [];
  private demands = new Map<string, PageDemand>();
  private cameraDemandCount = 0;
  private giDemandIds = new Set<string>();
  private giOnlyAdmitted: string[] = [];
  private generation = 1;
  private frame = 0;
  private dead = false;
  private uploads = 0;
  private evictions = 0;
  private failure: string | null = null;
  private readonly stride: number;
  private readonly tableWidth: number;

  constructor(private readonly renderer: THREE.WebGPURenderer, public source: LightmapPageSource, readonly slots = 8) {
    if (!Number.isInteger(slots) || slots < 1 || slots > 256) throw new Error('Invalid virtual lightmap cache capacity');
    const { size, pageSize, gutter, fallbackMip } = source;
    this.stride = pageSize + gutter * 2;
    this.tableWidth = Math.ceil(size / pageSize);
    let height = 0;
    for (let mip = 0; mip < fallbackMip; mip++) { this.rows.push(height); height += Math.ceil(size / 2 ** mip / pageSize); }
    this.tableData = new Uint32Array(this.tableWidth * height * 4);
    this.table = new THREE.DataTexture(this.tableData, this.tableWidth, height, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
    this.table.name = 'Lightmap / Page table';
    this.table.needsUpdate = true;
    this.physical = new THREE.DataArrayTexture(new Uint16Array(this.stride * this.stride * slots * 4), this.stride, this.stride, slots);
    this.physical.name = 'Lightmap / Resident pages';
    this.physical.type = THREE.HalfFloatType;
    this.physical.magFilter = this.physical.minFilter = THREE.LinearFilter;
    this.physical.needsUpdate = true;
    this.staging = new THREE.DataTexture(new Uint16Array(this.stride * this.stride * 4), this.stride, this.stride, THREE.RGBAFormat, THREE.HalfFloatType);
    const fallbackSize = size / 2 ** fallbackMip;
    this.fallback = new THREE.DataTexture(Uint16Array.from(source.fallback, THREE.DataUtils.toHalfFloat), fallbackSize, fallbackSize, THREE.RGBAFormat, THREE.HalfFloatType);
    this.fallback.name = 'Lightmap / Always resident fallback';
    this.fallback.magFilter = this.fallback.minFilter = THREE.LinearFilter;
    this.fallback.needsUpdate = true;
    renderer.initTexture(this.physical);
    renderer.initTexture(this.table);
    renderer.initTexture(this.fallback);
  }

  sample(uvInput: THREE.Node, boundsInput?: THREE.Node): THREE.Node {
    const filtered = this.filteredSampler(), b = filtered.bindings;
    return Fn(() => filtered.fn({ uvIn: vec2(uvInput), dx: dFdx(vec2(uvInput)), dy: dFdy(vec2(uvInput)),
      bounds: boundsInput ?? vec4(0, 0, 1, 1), maxAnisotropy: this.anisotropy,
      fallback: b.bakedFallback, fallbackSampler: b.bakedFallbackSampler,
      pages: b.bakedPages, pageSampler: b.bakedPageSampler, pageTable: b.bakedTable,
      nowMs: b.bakedClock, enabled: b.bakedEnabled }))();
  }

  /** Bounded anisotropic raster reconstruction; each tap uses the shared page resolver. */
  filteredSampler() {
    const sample = this.computeSampler(), { size, fallbackMip } = this.source;
    return { bindings: sample.bindings, fn: wgslFn(`fn sampleVirtualFiltered(uvIn: vec2f, dx: vec2f, dy: vec2f,
      bounds: vec4f, maxAnisotropy: f32, fallback: texture_2d<f32>, fallbackSampler: sampler,
      pages: texture_2d_array<f32>, pageSampler: sampler, pageTable: texture_2d<u32>, nowMs: f32, enabled: f32) -> vec3f {
      let footprint = virtualFootprint(dx * ${size}.0, dy * ${size}.0, maxAnisotropy);
      let lod = clamp(log2(footprint.z), 0.0, ${fallbackMip}.0);
      let count = i32(footprint.w);
      var result = vec3f(0.0);
      for (var i = 0; i < count; i++) {
        let offset = (f32(i) + 0.5) / f32(count) - 0.5;
        let uv = clamp(uvIn + footprint.xy * (offset / ${size}.0), bounds.xy, bounds.zw);
        result += sampleVirtualBaked(uv, lod, fallback, fallbackSampler, pages, pageSampler, pageTable, nowMs, enabled);
      }
      return result / f32(count);
    }`,
    // @ts-expect-error Three's include type omits callable wgslFn nodes, supported by its builder.
    [sample.fn, virtualFootprint]) };
  }

  setDemand(requests: PageDemand[], giRequests: PageDemand[] = []): void {
    const unique = new Map<string, PageDemand>();
    for (const request of requests) {
      const id = pageId(request.key);
      if (request.priority > (unique.get(id)?.priority ?? -1)) unique.set(id, request);
    }
    const rank = (a: [string, PageDemand], b: [string, PageDemand]) => b[1].priority - a[1].priority || a[0].localeCompare(b[0]);
    const cameraRanked = [...unique].sort(rank);
    const cameraAdmitted = new Set(cameraRanked.slice(0, this.slots).map(([id]) => id));
    const gi = new Map<string, PageDemand>();
    for (const request of giRequests) {
      const id = pageId(request.key), previous = gi.get(id);
      if (!previous || request.priority > previous.priority) gi.set(id, request);
    }
    // Share the existing physical budget. Give GI hits missing from camera
    // admission up to a quarter of slots (or unused camera space). A small
    // residency bias avoids churn when two stochastic votes have similar weight.
    const giBudget = Math.max(1, Math.floor(this.slots / 4), this.slots - unique.size);
    const extra = [...gi].filter(([id]) => !cameraAdmitted.has(id))
      .sort((a, b) => b[1].priority * (this.resident.has(b[0]) ? 1.2 : 1) -
        a[1].priority * (this.resident.has(a[0]) ? 1.2 : 1) || a[0].localeCompare(b[0]))
      .slice(0, giBudget);
    this.demands = new Map(extra);
    // Retain pages requested by both consumers before evicting camera detail.
    cameraRanked.sort((a, b) => Number(gi.has(b[0])) - Number(gi.has(a[0])) || rank(a, b));
    for (const [id, request] of cameraRanked) {
      if (this.demands.size >= this.slots) break;
      if (!this.demands.has(id)) this.demands.set(id, request);
    }
    this.cameraDemandCount = unique.size; this.giDemandIds = new Set(gi.keys());
    this.giOnlyAdmitted = extra.map(([id]) => id);
    for (const [id, controller] of this.pending) if (!this.demands.has(id)) {
      controller.abort(); this.pending.delete(id);
    }
  }

  /** Same resident pages, parent fallback and fade as raster; no screen derivatives. */
  computeSampler() {
    const { size, pageSize, gutter, fallbackMip } = this.source;
    let levels = '';
    for (let mip = fallbackMip - 1; mip >= 0; mip--) {
      levels += `{
        let pageUv = uv * ${size / 2 ** mip / pageSize}.0;
        let tile = vec2i(floor(pageUv));
        let entry = textureLoad(pageTable, tile + vec2i(0, ${this.rows[mip]}), 0);
        if (entry.r > 0u && lod < ${mip + 1}.0) {
          let local = (fract(pageUv) * ${pageSize}.0 + ${gutter}.0) / ${this.stride}.0;
          let detailed = textureSampleLevel(pages, pageSampler, local, i32(entry.r) - 1, 0.0).rgb;
          let fade = clamp((nowMs - f32(entry.g)) / 150.0, 0.0, 1.0) * enabled;
          result = mix(result, detailed, fade * (1.0 - clamp(lod - ${mip}.0, 0.0, 1.0)));
        }
      }`;
    }
    return { fn: wgslFn(`fn sampleVirtualBaked(uvIn: vec2f, lod: f32,
      fallback: texture_2d<f32>, fallbackSampler: sampler,
      pages: texture_2d_array<f32>, pageSampler: sampler, pageTable: texture_2d<u32>,
      nowMs: f32, enabled: f32) -> vec3f {
        let uv = clamp(uvIn, vec2f(0.0), vec2f(1.0 - 1e-7));
        var result = textureSampleLevel(fallback, fallbackSampler, uv, 0.0).rgb;
        ${levels}
        return result;
      }`), bindings: {
        bakedFallback: texture(this.fallback), bakedFallbackSampler: sampler(this.fallback),
        bakedPages: texture(this.physical), bakedPageSampler: sampler(this.physical),
        bakedTable: texture(this.table), bakedClock: this.clockMs, bakedEnabled: this.enabled,
      } };
  }

  update(nowMs: number, uploadBudget = 2): void {
    if (this.dead) return;
    this.clockMs.value = nowMs;
    this.frame++;
    for (const id of this.demands.keys()) { const page = this.resident.get(id); if (page) page.lastUsed = this.frame; }
    for (let uploaded = 0; this.ready.length && uploaded < uploadBudget;) {
      const page = this.ready.shift()!;
      const id = pageId(page.key);
      if (page.generation !== this.generation || !this.demands.has(id) || this.resident.has(id)) continue;
      let slot = 0;
      const used = new Set([...this.resident.values()].map(p => p.slot));
      while (used.has(slot)) slot++;
      if (slot >= this.slots) {
        const victim = [...this.resident.values()].filter(p => !this.demands.has(pageId(p.key))).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!victim) continue;
        slot = victim.slot;
        this.tableData.fill(0, this.offset(victim.key), this.offset(victim.key) + 4);
        this.resident.delete(pageId(victim.key));
        this.evictions++;
      }
      (this.staging.image.data as Uint16Array).set(Uint16Array.from(page.data, THREE.DataUtils.toHalfFloat));
      this.staging.needsUpdate = true;
      // r182's WebGPU upload ignores DataArrayTexture.layerUpdates. A single-page
      // staging texture + public GPU copy avoids re-uploading the entire array.
      this.renderer.copyTextureToTexture(this.staging, this.physical, null, new THREE.Vector3(0, 0, slot));
      const offset = this.offset(page.key);
      this.tableData[offset] = slot + 1;
      this.tableData[offset + 1] = Math.floor(nowMs);
      this.resident.set(id, { key: page.key, slot, lastUsed: this.frame });
      this.table.needsUpdate = true;
      this.uploads++; uploaded++;
    }
    const queued = new Set(this.ready.map(p => pageId(p.key)));
    for (const [id, request] of this.demands) {
      if (this.pending.size >= 4) break;
      if (this.resident.has(id) || this.pending.has(id) || queued.has(id)) continue;
      if ((this.failed.get(id)?.retryAt ?? 0) > nowMs) continue;
      const generation = this.generation;
      const controller = new AbortController();
      this.pending.set(id, controller);
      this.source.load(request.key, controller.signal).then(data => {
        if (!this.dead && !controller.signal.aborted && generation === this.generation) {
          if (data.length !== this.stride ** 2 * 4 || !data.every(Number.isFinite)) throw new Error('Invalid lightmap page pixels');
          this.failed.delete(id);
          this.ready.push({ key: request.key, data, generation });
        }
      }).catch(error => {
        if (this.dead || controller.signal.aborted || generation !== this.generation) return;
        this.failure = String(error);
        const attempts = (this.failed.get(id)?.attempts ?? 0) + 1;
        this.failed.set(id, { attempts, retryAt: performance.now() + Math.min(30000, 1000 * 2 ** (attempts - 1)) });
      }).finally(() => { if (this.pending.get(id) === controller) this.pending.delete(id); });
    }
  }

  clear(): void {
    this.generation++;
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear(); this.failed.clear();
    this.resident.clear(); this.ready.length = 0;
    this.tableData.fill(0); this.table.needsUpdate = true;
  }

  /** Re-baking an unchanged layout keeps the material's bound texture objects.
   * Replacing/disposal can leave r182 cached raster bindings on a recreated,
   * empty physical array even though the new compute sampler sees valid pages. */
  replaceSource(source: LightmapPageSource): boolean {
    if (this.dead || (['size', 'pageSize', 'gutter', 'fallbackMip'] as const).some(key => source[key] !== this.source[key])) return false;
    this.clear(); this.source = source; this.failure = null;
    (this.fallback.image.data as Uint16Array).set(Uint16Array.from(source.fallback, THREE.DataUtils.toHalfFloat));
    this.fallback.needsUpdate = true;
    return true;
  }

  stats() {
    return { virtualSize: this.source.size, pageSize: this.source.pageSize, gutter: this.source.gutter, fallbackMip: this.source.fallbackMip,
      slots: this.slots, resident: this.resident.size, demanded: this.demands.size, pending: this.pending.size, uploads: this.uploads, evictions: this.evictions, failure: this.failure,
      cameraDemanded: this.cameraDemandCount, giDemanded: this.giDemandIds.size,
      giOnlyAdmitted: this.giOnlyAdmitted, giAdmitted: [...this.demands.keys()].filter(id => this.giDemandIds.has(id)),
      retrying: this.failed.size, source: this.source.stats?.() ?? { kind: 'memory' },
      residentPages: [...this.resident.keys()],
      allocatedTextureBytes: this.stride ** 2 * (this.slots + 1) * 8 + this.source.fallback.length * 2 + this.tableData.byteLength };
  }

  dispose(): void {
    this.dead = true; this.generation++;
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear(); this.ready.length = 0;
    this.physical.dispose(); this.staging.dispose(); this.table.dispose(); this.fallback.dispose();
  }

  private offset({ mip, x, y }: LightmapPageKey): number { return ((this.rows[mip] + y) * this.tableWidth + x) * 4; }
}
