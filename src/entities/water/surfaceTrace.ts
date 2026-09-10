import { wgslFn } from 'three/tsl';
import { intersectsTriangle, rayStruct } from '../../shared/gi/bvh/webgpu/index.js';

export const waterVertex = wgslFn(`
  fn waterVertex(grid: vec2i, field: texture_2d<f32>, fieldSampler: sampler,
    cells: u32, halfSize: f32, level: f32, strength: f32) -> vec3f {
    let uv = vec2f(grid) / f32(cells);
    let height = textureSampleLevel(field, fieldSampler, uv, 0.0).x * strength + level + 0.0005;
    return vec3f((uv.x * 2.0 - 1.0) * halfSize, height, (uv.y * 2.0 - 1.0) * halfSize);
  }
`);

export const traceWaterSurface = wgslFn(`
  fn traceWaterSurface(origin: vec3f, direction: vec3f, maxDistance: f32,
    field: texture_2d<f32>, fieldSampler: sampler,
    cells: u32, halfSize: f32, level: f32, strength: f32) -> vec4f {
    var nearT = 0.0;
    var farT = maxDistance;
    let horizontalOrigin = origin.xz;
    let horizontalDirection = direction.xz;
    for (var axis = 0u; axis < 2u; axis++) {
      let d = horizontalDirection[axis];
      let p = horizontalOrigin[axis];
      if (abs(d) < 1e-10) {
        if (abs(p) > halfSize) { return vec4f(0.0); }
      } else {
        let a = (-halfSize - p) / d;
        let b = (halfSize - p) / d;
        nearT = max(nearT, min(a, b));
        farT = min(farT, max(a, b));
      }
    }
    if (farT < nearT) { return vec4f(0.0); }
    let cellSize = 2.0 * halfSize / f32(cells);
    let enter = horizontalOrigin + horizontalDirection * nearT;
    var cell = clamp(vec2i(floor((enter + halfSize) / cellSize)), vec2i(0), vec2i(i32(cells) - 1));
    let step = vec2i(select(-1, 1, direction.x >= 0.0), select(-1, 1, direction.z >= 0.0));
    var nextT = vec2f(1e20);
    var deltaT = vec2f(1e20);
    for (var axis = 0u; axis < 2u; axis++) {
      if (abs(horizontalDirection[axis]) >= 1e-10) {
        let boundary = -halfSize + f32(cell[axis] + select(0, 1, step[axis] > 0)) * cellSize;
        nextT[axis] = (boundary - horizontalOrigin[axis]) / horizontalDirection[axis];
        deltaT[axis] = cellSize / abs(horizontalDirection[axis]);
      }
    }
    var ray: Ray;
    ray.origin = origin;
    ray.direction = direction;
    for (var visited = 0u; visited < cells * 2u + 2u; visited++) {
      let a = waterVertex(cell, field, fieldSampler, cells, halfSize, level, strength);
      let b = waterVertex(cell + vec2i(0, 1), field, fieldSampler, cells, halfSize, level, strength);
      let c = waterVertex(cell + vec2i(1, 1), field, fieldSampler, cells, halfSize, level, strength);
      let d = waterVertex(cell + vec2i(1, 0), field, fieldSampler, cells, halfSize, level, strength);
      let first = intersectsTriangle(ray, a, b, d);
      let second = intersectsTriangle(ray, b, c, d);
      let firstValid = first.didHit && first.dist <= farT;
      let secondValid = second.didHit && second.dist <= farT;
      if (firstValid && (!secondValid || first.dist <= second.dist)) { return vec4f(first.normal, first.dist); }
      if (secondValid) { return vec4f(second.normal, second.dist); }
      let axis = select(1u, 0u, nextT.x <= nextT.y);
      if (nextT[axis] > farT) { break; }
      cell[axis] += step[axis];
      if (cell[axis] < 0 || cell[axis] >= i32(cells)) { break; }
      nextT[axis] += deltaT[axis];
    }
    return vec4f(0.0);
  }
`, [waterVertex, intersectsTriangle, rayStruct] as unknown as NonNullable<Parameters<typeof wgslFn>[1]>);
