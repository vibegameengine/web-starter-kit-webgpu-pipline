import * as THREE from 'three/webgpu';
import type { LightmapRegion } from './chartPadding.ts';

export interface LeakStage { name: string; values: Float32Array }

export interface LeakTexelReport {
  texel: [number, number];
  chart: number;
  uv: [number, number];
  world: [number, number, number] | null;
  normal: [number, number, number] | null;
  stages: Record<string, [number, number, number, number]>;
  firstChangedStage: string | null;
}

export interface LeakStageChange {
  from: string;
  to: string;
  changed: number;
  maxDelta: number;
  at: [number, number];
  chart: number;
  world: [number, number, number] | null;
}

export interface LeakInventedLight {
  stage: string;
  count: number;
  worst: LeakTexelReport | null;
}

const DIFF_PREFIX = 'diff:';
const DEFAULT_TOLERANCE = 1e-4;
const DEFAULT_BLACK_LEVEL = 0.002;

const luma = (p: Float32Array, i: number) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
const delta = (a: Float32Array, b: Float32Array, i: number) =>
  Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);

/* @important Only texels inside a chart rectangle are kept. The corridor's atlas grows to 2048²,
   where one full stage is 67 MB and the chain would cost 400 MB; the charts are 22 % of it, and
   `padLightmapCharts` forces everything outside them to zero, so the rest carries no evidence. */
export class BakeLeakStages {
  readonly view: THREE.DataTexture;
  readonly stages: LeakStage[] = [];
  readonly slotOfTexel: Int32Array;
  readonly texelOfSlot: Int32Array;
  readonly chartOfSlot: Int32Array;
  world: Float32Array | null = null;
  normals: Float32Array | null = null;
  diffGain = 8;
  shown = '';

  constructor(readonly size: number, readonly regions: LightmapRegion[]) {
    this.slotOfTexel = new Int32Array(size * size).fill(-1);
    let slots = 0;
    for (const [chart, region] of regions.entries()) {
      for (let y = region.y; y < region.y + region.height; y++) {
        for (let x = region.x; x < region.x + region.width; x++) {
          if (this.slotOfTexel[y * size + x] >= 0) continue;
          this.slotOfTexel[y * size + x] = chart;
          slots++;
        }
      }
    }
    this.texelOfSlot = new Int32Array(slots);
    this.chartOfSlot = new Int32Array(slots);
    let slot = 0;
    for (let texel = 0; texel < this.slotOfTexel.length; texel++) {
      const chart = this.slotOfTexel[texel];
      if (chart < 0) continue;
      this.chartOfSlot[slot] = chart;
      this.texelOfSlot[slot] = texel;
      this.slotOfTexel[texel] = slot++;
    }
    const data = new Uint16Array(size * size * 4);
    this.view = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.HalfFloatType);
    this.view.magFilter = this.view.minFilter = THREE.NearestFilter;
    this.view.needsUpdate = true;
  }

  get slots(): number { return this.texelOfSlot.length; }

  record(name: string, pixels: Float32Array): void {
    if (pixels.length !== this.size * this.size * 4) throw new Error(`leak stage ${name}: ${pixels.length} floats for a ${this.size} atlas`);
    const values = new Float32Array(this.slots * 4);
    for (let slot = 0; slot < this.slots; slot++) {
      const from = this.texelOfSlot[slot] * 4;
      values.set(pixels.subarray(from, from + 4), slot * 4);
    }
    const stage = { name, values };
    const at = this.stages.findIndex((s) => s.name === name);
    if (at >= 0) this.stages[at] = stage;
    else this.stages.push(stage);
    if (this.shown === '' || this.shown === name) this.show(name);
  }

  options(): string[] {
    return this.stages.flatMap((stage, i) => (i === 0 ? [stage.name] : [stage.name, DIFF_PREFIX + stage.name]));
  }

  show(option: string): boolean {
    const isDifference = option.startsWith(DIFF_PREFIX);
    const name = isDifference ? option.slice(DIFF_PREFIX.length) : option;
    const order = this.stages.findIndex((stage) => stage.name === name);
    if (order < 0 || (isDifference && order === 0)) return false;
    const current = this.stages[order].values;
    const previous = isDifference ? this.stages[order - 1].values : null;
    const out = this.view.image.data as Uint16Array;
    out.fill(0);
    const opaque = THREE.DataUtils.toHalfFloat(1);
    for (let slot = 0; slot < this.slots; slot++) {
      const to = this.texelOfSlot[slot] * 4;
      const from = slot * 4;
      for (let channel = 0; channel < 3; channel++) {
        const value = previous
          ? Math.abs(current[from + channel] - previous[from + channel]) * this.diffGain
          : current[from + channel];
        out[to + channel] = THREE.DataUtils.toHalfFloat(value);
      }
      out[to + 3] = opaque;
    }
    this.view.needsUpdate = true;
    this.shown = option;
    return true;
  }

  private vectorAt(source: Float32Array | null, texel: number): [number, number, number] | null {
    return source ? [source[texel * 4], source[texel * 4 + 1], source[texel * 4 + 2]] : null;
  }

  private reportOfSlot(slot: number, tolerance = DEFAULT_TOLERANCE): LeakTexelReport | null {
    const texel = this.texelOfSlot[slot];
    return this.inspect(texel % this.size, Math.floor(texel / this.size), tolerance);
  }

  inspect(x: number, y: number, tolerance = DEFAULT_TOLERANCE): LeakTexelReport | null {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return null;
    const texel = y * this.size + x;
    const slot = this.slotOfTexel[texel];
    if (slot < 0 || this.stages.length === 0) return null;
    const i = slot * 4;
    const stages: Record<string, [number, number, number, number]> = {};
    let firstChangedStage: string | null = null;
    for (const [order, stage] of this.stages.entries()) {
      const v = stage.values;
      stages[stage.name] = [v[i], v[i + 1], v[i + 2], v[i + 3]];
      if (order > 0 && firstChangedStage === null && delta(v, this.stages[order - 1].values, i) > tolerance) firstChangedStage = stage.name;
    }
    return {
      texel: [x, y],
      chart: this.chartOfSlot[slot],
      uv: [(x + 0.5) / this.size, (y + 0.5) / this.size],
      world: this.vectorAt(this.world, texel),
      normal: this.vectorAt(this.normals, texel),
      stages,
      firstChangedStage,
    };
  }

  firstChange(tolerance = DEFAULT_TOLERANCE): LeakStageChange[] {
    const out: LeakStageChange[] = [];
    for (let order = 1; order < this.stages.length; order++) {
      const to = this.stages[order];
      const from = this.stages[order - 1];
      let changed = 0;
      let maxDelta = 0;
      let worst = 0;
      for (let slot = 0; slot < this.slots; slot++) {
        const moved = delta(to.values, from.values, slot * 4);
        if (moved <= tolerance) continue;
        changed++;
        if (moved > maxDelta) { maxDelta = moved; worst = slot; }
      }
      const texel = this.texelOfSlot[worst];
      out.push({
        from: from.name, to: to.name, changed, maxDelta: +maxDelta.toFixed(6),
        at: [texel % this.size, Math.floor(texel / this.size)],
        chart: this.chartOfSlot[worst], world: this.vectorAt(this.world, texel),
      });
    }
    return out;
  }

  inventedLight(blackLevel = DEFAULT_BLACK_LEVEL): LeakInventedLight[] {
    return this.stages.slice(1).map((stage, index) => {
      const to = stage.values;
      const from = this.stages[index].values;
      let count = 0;
      let worst = -1;
      let brightest = blackLevel;
      for (let slot = 0; slot < this.slots; slot++) {
        const i = slot * 4;
        if (luma(from, i) > blackLevel || luma(to, i) <= blackLevel) continue;
        count++;
        if (luma(to, i) > brightest) { brightest = luma(to, i); worst = slot; }
      }
      return { stage: stage.name, count, worst: worst < 0 ? null : this.reportOfSlot(worst) };
    });
  }
}

export function leakHookApi(leak: BakeLeakStages, onShown?: () => void) {
  return {
    stages: () => leak.stages.map((stage) => stage.name),
    slots: () => leak.slots,
    show: (option: string) => { const ok = leak.show(option); if (ok) onShown?.(); return ok; },
    gain: (value: number) => { leak.diffGain = value; return leak.show(leak.shown); },
    inspect: (x: number, y: number) => leak.inspect(x, y),
    firstChange: (tolerance?: number) => leak.firstChange(tolerance),
    inventedLight: (blackLevel?: number) => leak.inventedLight(blackLevel),
  };
}
