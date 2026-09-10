import type * as THREE from 'three/webgpu';

type PassStats = { name: string; gpu: number; cpu: number; renderTarget?: { width: number; height: number; texture?: { name: string }; textures?: { name: string }[] }; isComputeStats?: boolean };
type FrameRecord = { frameId: number; deltaTime: number; resolvedRender: boolean; resolvedCompute: boolean; renders: PassStats[]; computes: PassStats[] };
type PassAccumulator = { gpu: number[]; cpu: number[]; count: number[] };

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

function passLabel(s: PassStats): string {
  if (s.isComputeStats) return `compute ${s.name || '(unnamed)'}`;
  const rt = s.renderTarget;
  if (!rt) return `${s.name} → screen`;
  const tex = rt.texture?.name || rt.textures?.[0]?.name;
  return `${s.name} → ${tex || 'rt'} ${rt.width}x${rt.height}`;
}

function accumulateFrame(frame: FrameRecord, per: Map<string, PassAccumulator>): number {
  const byLabel = new Map<string, { gpu: number; cpu: number; count: number }>();
  let total = 0;
  for (const s of [...frame.renders, ...frame.computes]) {
    const key = passLabel(s);
    const e = byLabel.get(key) ?? { gpu: 0, cpu: 0, count: 0 };
    e.gpu += s.gpu; e.cpu += s.cpu; e.count++; byLabel.set(key, e);
    total += s.gpu;
  }
  for (const [key, e] of byLabel) {
    const acc = per.get(key) ?? { gpu: [], cpu: [], count: [] };
    acc.gpu.push(e.gpu); acc.cpu.push(e.cpu); acc.count.push(e.count); per.set(key, acc);
  }
  return total;
}

export async function gpuPasses(renderer: THREE.WebGPURenderer, frames = 60) {
  const inspector = renderer.inspector as unknown as { frames: FrameRecord[]; resolveTimestamp(): Promise<void> };
  const firstFrame = inspector.frames.length ? inspector.frames[inspector.frames.length - 1].frameId + 1 : 0;
  for (let i = 0; i < frames; i++) { await new Promise((r) => requestAnimationFrame(r)); await inspector.resolveTimestamp(); }
  await inspector.resolveTimestamp();
  const per = new Map<string, PassAccumulator>();
  const intervals: number[] = [];
  const totals: number[] = [];
  let used = 0;
  for (const f of inspector.frames) {
    if (f.frameId < firstFrame || !f.resolvedRender || !f.resolvedCompute) continue;
    used++;
    intervals.push(f.deltaTime);
    totals.push(accumulateFrame(f, per));
  }
  const passes = [...per].map(([name, a]) => ({ name, gpu: median(a.gpu), cpu: median(a.cpu), perFrame: median(a.count), frames: a.gpu.length }))
    .sort((x, y) => y.gpu - x.gpu);
  return { framesUsed: used, frameMs: median(intervals), gpuMs: median(totals), passes };
}
