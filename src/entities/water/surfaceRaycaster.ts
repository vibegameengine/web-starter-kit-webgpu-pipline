import * as THREE from 'three/webgpu';
import { float, sampler, storage, texture, uint, wgslFn } from 'three/tsl';
import { intersectsTriangle, rayStruct } from '../../shared/gi/bvh/webgpu/index.js';
import { waterVertex } from './surfaceTrace.ts';

const morton = wgslFn(`
  fn waterMorton(v: vec2u) -> u32 {
    var p = v;
    p = (p | (p << vec2u(8u))) & vec2u(0x00ff00ffu);
    p = (p | (p << vec2u(4u))) & vec2u(0x0f0f0f0fu);
    p = (p | (p << vec2u(2u))) & vec2u(0x33333333u);
    p = (p | (p << vec2u(1u))) & vec2u(0x55555555u);
    return p.x | (p.y << 1u);
  }
`);

const boxDistance = wgslFn(`
  fn waterBoxDistance(origin: vec3f, direction: vec3f, lo: vec3f, hi: vec3f, maximum: f32) -> f32 {
    let inverse = 1.0 / select(vec3f(1e-20), direction, abs(direction) > vec3f(1e-20));
    let a = (lo - origin) * inverse;
    let b = (hi - origin) * inverse;
    let parallel = abs(direction) < vec3f(1e-20);
    if (any(parallel & ((origin < lo) | (origin > hi)))) { return -1.0; }
    let enter = select(min(a, b), vec3f(-1e30), parallel);
    let leave = select(max(a, b), vec3f(1e30), parallel);
    let near = max(0.0, max(enter.x, max(enter.y, enter.z)));
    let far = min(maximum, min(leave.x, min(leave.y, leave.z)));
    return select(-1.0, near, far >= near);
  }
`);

export class SurfaceRaycaster {
  readonly trace;
  readonly traceWork;
  readonly attribute: THREE.StorageBufferAttribute;
  private readonly build: THREE.ComputeNode[] = [];

  constructor(field: THREE.Texture, cells: number, half: number, level: number, strength: THREE.Node) {
    if (cells < 2 || (cells & (cells - 1)) !== 0 || cells > 512) throw new Error('Water ray grid must be a power of two up to 512');
    const nodes = (4 * cells * cells - 1) / 3;
    const firstLeaf = (cells * cells - 1) / 3;
    this.attribute = new THREE.StorageBufferAttribute(new Float32Array(nodes * 2), 2);
    const write = storage(this.attribute, 'vec2', nodes).setName('water_tree_write');
    const read = storage(this.attribute, 'vec2', nodes).toReadOnly().setName('water_tree');
    const leaves = wgslFn(`
      fn waterBuildLeaves(field: texture_2d<f32>, fieldSampler: sampler, cells: u32, halfSize: f32, level: f32, strength: f32, firstLeaf: u32) -> void {
        let i = instanceIndex;
        if (i >= cells * cells) { return; }
        let cell = vec2i(vec2u(i % cells, i / cells));
        let a = waterVertex(cell, field, fieldSampler, cells, halfSize, level, strength).y;
        let b = waterVertex(cell + vec2i(0, 1), field, fieldSampler, cells, halfSize, level, strength).y;
        let c = waterVertex(cell + vec2i(1, 1), field, fieldSampler, cells, halfSize, level, strength).y;
        let d = waterVertex(cell + vec2i(1, 0), field, fieldSampler, cells, halfSize, level, strength).y;
        water_tree_write.value[firstLeaf + waterMorton(vec2u(cell))] = vec2f(min(min(a, b), min(c, d)) - 0.0001, max(max(a, b), max(c, d)) + 0.0001);
      }
    `, [write, waterVertex, morton] as unknown as NonNullable<Parameters<typeof wgslFn>[1]>);
    this.build.push(leaves({ field: texture(field), fieldSampler: sampler(field), cells: uint(cells), halfSize: float(half), level: float(level), strength, firstLeaf: uint(firstLeaf) }).compute(cells * cells));
    const reduce = wgslFn(`
      fn waterBuildParents(first: u32, count: u32) -> void {
        if (instanceIndex >= count) { return; }
        let node = first + instanceIndex;
        let child = node * 4u + 1u;
        let a = water_tree_write.value[child];
        let b = water_tree_write.value[child + 1u];
        let c = water_tree_write.value[child + 2u];
        let d = water_tree_write.value[child + 3u];
        water_tree_write.value[node] = vec2f(min(min(a.x, b.x), min(c.x, d.x)), max(max(a.y, b.y), max(c.y, d.y)));
      }
    `, [write]);
    for (let width = cells / 2; width >= 1; width /= 2) this.build.push(reduce({ first: uint((width * width - 1) / 3), count: uint(width * width) }).compute(width * width));
    const traverse = wgslFn(`
      fn waterTraceTree(origin: vec3f, direction: vec3f, maximum: f32, audit: u32,
        field: texture_2d<f32>, fieldSampler: sampler, cells: u32, halfSize: f32, level: f32, strength: f32) -> vec4f {
        var node = vec4u(0u, 0u, 0u, cells);
        let preferred = select(0u, 1u, direction.x < 0.0) | select(0u, 2u, direction.z < 0.0);
        var closest = maximum;
        var result = vec4f(0.0);
        var visits = 0u;
        let unit = 2.0 * halfSize / f32(cells);
        var ray: Ray;
        ray.origin = origin;
        ray.direction = direction;
        loop {
          visits++;
          let heights = water_tree.value[node.x];
          let corner = vec2f(node.yz) * unit - halfSize;
          let end = corner + f32(node.w) * unit;
          let near = waterBoxDistance(origin, direction, vec3f(corner.x, heights.x, corner.y), vec3f(end.x, heights.y, end.y), closest);
          if (near >= 0.0 && node.w == 1u) {
            let cell = vec2i(node.yz);
            let a = waterVertex(cell, field, fieldSampler, cells, halfSize, level, strength);
            let b = waterVertex(cell + vec2i(0, 1), field, fieldSampler, cells, halfSize, level, strength);
            let c = waterVertex(cell + vec2i(1, 1), field, fieldSampler, cells, halfSize, level, strength);
            let d = waterVertex(cell + vec2i(1, 0), field, fieldSampler, cells, halfSize, level, strength);
            let first = intersectsTriangle(ray, a, b, d);
            let second = intersectsTriangle(ray, b, c, d);
            if (first.didHit && first.dist < closest) { closest = first.dist; result = vec4f(first.normal, first.dist); }
            if (second.didHit && second.dist < closest) { closest = second.dist; result = vec4f(second.normal, second.dist); }
          } else if (near >= 0.0) {
            let span = node.w / 2u;
            node = vec4u(node.x * 4u + 1u + preferred, node.y + (preferred & 1u) * span, node.z + (preferred >> 1u) * span, span);
            continue;
          }
          loop {
            if (node.x == 0u) {
              if (audit > 0u) { return vec4f(f32(visits), result.w, 0.0, 1.0); }
              return result;
            }
            let child = (node.x - 1u) % 4u;
            let order = child ^ preferred;
            let parent = (node.x - 1u) / 4u;
            let parentSpan = node.w * 2u;
            let parentCorner = node.yz & vec2u(~(parentSpan - 1u));
            if (order < 3u) {
              let next = (order + 1u) ^ preferred;
              node = vec4u(parent * 4u + 1u + next, parentCorner.x + (next & 1u) * node.w, parentCorner.y + (next >> 1u) * node.w, node.w);
              break;
            }
            node = vec4u(parent, parentCorner, parentSpan);
          }
        }
        if (audit > 0u) { return vec4f(f32(visits), result.w, 0.0, 1.0); }
        return result;
      }
    `, [read, boxDistance, waterVertex, rayStruct, intersectsTriangle] as unknown as NonNullable<Parameters<typeof wgslFn>[1]>);
    const query = (origin: THREE.Node, direction: THREE.Node, maximum: THREE.Node, audit: number) => traverse({ origin, direction, maximum, audit: uint(audit),
      field: texture(field), fieldSampler: sampler(field), cells: uint(cells), halfSize: float(half), level: float(level), strength });
    this.trace = (origin: THREE.Node, direction: THREE.Node, maximum: THREE.Node) => query(origin, direction, maximum, 0);
    this.traceWork = (origin: THREE.Node, direction: THREE.Node, maximum: THREE.Node) => query(origin, direction, maximum, 1);
  }

  update(renderer: THREE.WebGPURenderer): void { renderer.compute(this.build); }

  dispose(renderer: THREE.WebGPURenderer): void {
    (renderer.backend as unknown as { destroyAttribute(value: THREE.StorageBufferAttribute): void }).destroyAttribute(this.attribute);
  }
}

