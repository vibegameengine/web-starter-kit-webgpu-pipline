// @ts-nocheck -- production WGSL storage bindings follow the surfel passes.
import * as THREE from 'three/webgpu';
import { storage, uniform, wgslFn, instanceIndex } from 'three/tsl';
import { SurfelStruct, SurfelMoments } from './surfelPool';
import { SURFEL_TTL } from './constants';

/** GPU-only admission of primary GI samples. Shadow/depth rays have separate costs. */
export function createIntegrationSchedule() {
  let source = null, state = null, bins = null, rows = null, nodes = [];
  let tick = 0;
  const U_TICK = uniform(0, 'uint'), U_FRAME = uniform(0, 'uint');
  const U_READ = uniform(0, 'uint'), U_BASE = uniform(4, 'uint'), U_BUDGET = uniform(4096, 'uint');
  function dispose(renderer) {
    nodes.forEach(node => node.dispose()); nodes = [];
    for (const attr of [state, bins]) if (attr && renderer.backend.has(attr)) renderer.backend.destroyAttribute(attr);
    source = state = bins = rows = null; tick = 0;
  }
  function run(renderer, pool, budget, baseSamples) {
    if (source !== pool.getSurfelAttr()) {
      dispose(renderer); source = pool.getSurfelAttr();
      const capacity = pool.getCapacity();
      // Per slot: generation/last update/priority/request, last position/valid,
      // last normal/admitted primary samples. Positions change only on admission.
      state = new THREE.StorageBufferAttribute(new Float32Array(capacity * 12), 4);
      bins = new THREE.StorageBufferAttribute(new Uint32Array(64 * 3), 1);
      rows = storage(state, 'vec4', state.count).setName('integrationSchedule');
      const buckets = storage(bins, 'uint', bins.count).toAtomic().setName('scheduleBins');
      const surfels = storage(source, SurfelStruct, capacity).toReadOnly().setName('scheduleSurfels');
      const moments = storage(pool.getMomentsAttr(), SurfelMoments, capacity * 2).setName('scheduleMoments');
      const reset = wgslFn(`fn resetSchedule(i: u32) -> void {
        atomicStore(&scheduleBins.value[i], 0u);
        atomicStore(&scheduleBins.value[i + 64u], 0u);
        atomicStore(&scheduleBins.value[i + 128u], 0u);
      }`, [buckets]);
      const classify = wgslFn(`fn classifySchedule(i: u32, tick: u32, frame: u32, readOffset: u32, base: u32) -> void {
        if (i >= ${capacity}u) { return; }
        let s = scheduleSurfels.value[i];
        let old = integrationSchedule.value[i * 3u];
        integrationSchedule.value[i * 3u].w = 0.0;
        integrationSchedule.value[i * 3u + 2u].w = 0.0;
        // The output diagnostic is scratch until integration publishes this frame.
        // Reusing it keeps the integrator within its existing 14 storage bindings.
        scheduleMoments.value[i + (${capacity}u - readOffset)].hit.w = 0.0;
        if (s.age < 0 || s.age >= ${SURFEL_TTL}) {
          integrationSchedule.value[i * 3u + 1u].w = 0.0;
          return;
        }
        var last = u32(old.y);
        if (old.x != s.posb.w) {
          last = tick - 1u;
          integrationSchedule.value[i * 3u + 1u].w = 0.0;
        }
        let m = scheduleMoments.value[i + readOffset];
        let p = integrationSchedule.value[i * 3u + 1u];
        let n = integrationSchedule.value[i * 3u + 2u];
        let fresh = p.w == 0.0 || m.irradiance.w < 32.0 || frame - u32(s.posb.w) <= 4u;
        let moved = distance(p.xyz, s.posb.xyz) > 0.0001 || dot(n.xyz, s.normal) < 0.9999;
        let unstable = m.msmeData1.w > 0.3;
        let wait = tick - last;
        // Even converged receivers are revisited: another object's shadow or a
        // light can change without moving this surface. No permanent freezing.
        let stable = !fresh && !moved && m.irradiance.w >= 64.0 && m.msmeData1.w < 0.1;
        var request = max(1u, base) + select(0u, 12u, unstable);
        if (fresh) { request = 32u; }
        if (stable && wait < 4u) { request = 0u; }
        let bonus = select(select(select(0u, 2u, unstable), 4u, moved), 8u, fresh);
        let priority = min(63u, wait + bonus);
        integrationSchedule.value[i * 3u] = vec4f(s.posb.w, f32(last), f32(priority), f32(request));
        atomicAdd(&scheduleBins.value[priority], request);
      }`, [rows, buckets, surfels, moments]);
      const prefix = wgslFn(`fn prefixSchedule(budget: u32) -> void {
        var total = 0u;
        for (var p = 63i; p >= 0i; p--) {
          atomicStore(&scheduleBins.value[u32(p) + 128u], min(total, budget));
          total += atomicLoad(&scheduleBins.value[u32(p)]);
        }
      }`, [buckets]);
      const admit = wgslFn(`fn admitSchedule(invocation: u32, tick: u32, budget: u32, readOffset: u32) -> void {
        if (invocation >= ${capacity}u) { return; }
        // Rotate slot order inside equal priority classes; no fixed low-id preference.
        let i = (invocation + tick * 17u) % ${capacity}u;
        let row = integrationSchedule.value[i * 3u];
        let request = u32(row.w);
        if (request == 0u) { return; }
        let p = u32(row.z);
        let offset = atomicLoad(&scheduleBins.value[p + 128u]) + atomicAdd(&scheduleBins.value[p + 64u], request);
        let count = min(request, budget - min(budget, offset));
        integrationSchedule.value[i * 3u + 2u].w = f32(count);
        scheduleMoments.value[i + (${capacity}u - readOffset)].hit.w = f32(count);
        if (count > 0u) {
          let s = scheduleSurfels.value[i];
          integrationSchedule.value[i * 3u].y = f32(tick);
          integrationSchedule.value[i * 3u + 1u] = vec4f(s.posb.xyz, 1.0);
          integrationSchedule.value[i * 3u + 2u] = vec4f(s.normal, f32(count));
        }
      }`, [rows, buckets, surfels, moments]);
      nodes = [reset({ i: instanceIndex }).compute(64).setName('GI Schedule Reset'),
        classify({ i: instanceIndex, tick: U_TICK, frame: U_FRAME, readOffset: U_READ, base: U_BASE }).compute(capacity).setName('GI Schedule Classify'),
        prefix({ budget: U_BUDGET }).compute(1).setName('GI Schedule Prefix'),
        admit({ invocation: instanceIndex, tick: U_TICK, budget: U_BUDGET, readOffset: U_READ }).compute(capacity).setName('GI Schedule Admit')];
    }
    U_TICK.value = ++tick; U_FRAME.value = renderer.info.frame;
    U_READ.value = pool.getOffsets().readOffset; U_BASE.value = Math.max(1, Math.floor(baseSamples));
    U_BUDGET.value = Math.max(1, Math.floor(budget));
    nodes.forEach(node => renderer.compute(node));
    return true;
  }
  async function read(renderer) {
    if (!state) return null;
    return { tick, budget: U_BUDGET.value, bytes: state.array.byteLength + bins.array.byteLength,
      rows: Array.from(new Float32Array(await renderer.getArrayBufferAsync(state))) };
  }
  return { run, read, dispose };
}
