// @ts-nocheck -- TSL structured storage follows the Webgiya compute passes.
import * as THREE from 'three/webgpu';
import { Fn, If, storage, int, instanceIndex, uniform, vec4 } from 'three/tsl';
import { SurfelMoments, type SurfelPool } from '../surfel/surfelPool';
import { pageId, type LightmapPageSource } from '../../render/virtualTexture/lightmapPages';
import type { PageDemand } from '../../render/virtualTexture/virtualLightmap';

/** Read only page feedback, not the full double-buffered irradiance history.
 * One GPU copy/readback in flight, sampled at most once per 150 ms. */
export class BakedPageFeedback {
  private attribute = null;
  private node = null;
  private pool = null;
  private source = null;
  private epoch = 0;
  private pending = false;
  private nextAt = 0;
  private scores = new Map<string, { demand: PageDemand; seen: number }>();
  private offset = uniform(0);
  private frame = uniform(0);
  private snapshots = 0;
  private samples = 0;
  private mipHistogram: number[] = [];
  private failure = null;

  reset(renderer) {
    this.epoch++;
    this.node?.dispose(); this.node = null;
    if (this.attribute && renderer.backend.has(this.attribute) && renderer.backend.get(this.attribute).buffer) {
      renderer.backend.destroyAttribute(this.attribute);
    }
    this.attribute = null; this.pool = null; this.source = null;
    this.scores.clear(); this.nextAt = 0;
    // A pending read owns its staging copy. Its completion must release the gate;
    // epoch rejection prevents it from publishing into a different bake/pool.
  }

  update(renderer, pool: SurfelPool, source: LightmapPageSource, nowMs: number) {
    if (this.pool !== pool || this.source !== source) {
      this.reset(renderer); this.pool = pool; this.source = source;
    }
    if (this.pending || nowMs < this.nextAt || source.fallbackMip < 1) return;
    if (!this.node) {
      this.attribute = new THREE.StorageBufferAttribute(new Float32Array(pool.getCapacity() * 4), 4);
      const output = storage(this.attribute, 'vec4', pool.getCapacity());
      const moments = storage(pool.getMomentsAttr(), SurfelMoments, pool.getCapacity() * 2).toReadOnly();
      this.node = Fn(() => {
        const sid = int(instanceIndex), momentIndex = sid.add(int(this.offset)).toVar();
        const entry = moments.element(momentIndex).get('hit');
        output.element(sid).assign(vec4(0));
        If(entry.w.equal(this.frame), () => { output.element(sid).assign(entry); });
      })().compute(pool.getCapacity()).setName('Collect Baked Page Feedback');
    }
    this.offset.value = pool.getOffsets().readOffset;
    this.frame.value = renderer.info.frame;
    renderer.compute(this.node);
    const epoch = this.epoch;
    this.pending = true; this.nextAt = nowMs + 150;
    renderer.getArrayBufferAsync(this.attribute).then(buffer => {
      if (epoch !== this.epoch) return;
      const data = new Float32Array(buffer), votes = new Map<string, PageDemand>();
      let accepted = 0;
      const mipHistogram = new Array(source.fallbackMip + 1).fill(0);
      for (let i = 0; i < data.length; i += 4) {
        // z packs floor(LOD) in multiples of 16 and importance in (0, 8].
        // w remains the frame stamp: no extra per-probe storage/readback.
        const u = data[i], v = data[i + 1], packed = data[i + 2];
        const firstMip = Math.floor(packed / 16), weight = packed - firstMip * 16;
        if (!(weight > 0) || !Number.isFinite(weight) || u < 0 || u >= 1 || v < 0 || v >= 1) continue;
        if (firstMip < 0 || firstMip > source.fallbackMip) continue;
        accepted++;
        mipHistogram[firstMip]++;
        // Request the actual trilinear footprint and its fallback parents, never
        // finer pages that this hit cannot consume. Resident fallback needs no IO.
        for (let mip = firstMip; mip < source.fallbackMip; mip++) {
          const side = source.size / 2 ** mip / source.pageSize;
          const key = { mip, x: Math.floor(u * side), y: Math.floor(v * side) }, id = pageId(key);
          const previous = votes.get(id);
          votes.set(id, { key, priority: (previous?.priority ?? 0) + Math.min(weight, 8) * 2 ** mip });
        }
      }
      const arrived = performance.now();
      for (const [id, demand] of votes) {
        const previous = this.scores.get(id);
        this.scores.set(id, { demand: { ...demand, priority: previous
          ? previous.demand.priority * .6 + demand.priority * .4 : demand.priority }, seen: arrived });
      }
      this.samples = accepted; this.mipHistogram = mipHistogram; this.snapshots++; this.failure = null;
    }).catch(error => { if (epoch === this.epoch) this.failure = String(error); })
      .finally(() => { this.pending = false; });
  }

  demands(nowMs: number): PageDemand[] {
    for (const [id, item] of this.scores) if (nowMs - item.seen > 750) this.scores.delete(id);
    return [...this.scores.values()].map(item => item.demand);
  }

  stats() {
    return { snapshots: this.snapshots, samples: this.samples, mipHistogram: this.mipHistogram, pending: this.pending,
      bytesPerSnapshot: this.attribute?.array.byteLength ?? 0, failure: this.failure,
      demandedPages: this.demands(performance.now()).map(d => pageId(d.key)) };
  }
}
