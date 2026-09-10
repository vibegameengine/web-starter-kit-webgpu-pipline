import type * as THREE from 'three/webgpu';
import { SEAWATER_INDEX_550_NM } from './physicsReference.ts';
import { Fn, If, Loop, abs, cameraPosition, cameraProjectionMatrix, cameraProjectionMatrixInverse, cameraViewMatrix, cameraWorldMatrix, clamp, distance, dot, float, fwidth, getViewPosition, max, min, normalize, positionView, positionWorld, refract, screenUV, select, texture, vec2, vec3, vec4 } from 'three/tsl';

export function waterRefraction(screen: { color: THREE.Texture; depth: THREE.Texture; normal: THREE.Texture }, normal: THREE.Node, level: ReturnType<typeof float>, half: ReturnType<typeof float>) {
  const p = positionWorld;
  const ray = refract(normalize(p.sub(cameraPosition)), normal as THREE.Node, 1 / SEAWATER_INDEX_550_NM);
  const depthAt = (uv: THREE.Node) => texture(screen.depth, uv).level(float(0)).r;
  const reconstruct = (uv: THREE.Node, depth: ReturnType<typeof float>) => cameraWorldMatrix.mul(vec4(getViewPosition(uv, depth, cameraProjectionMatrixInverse), 1)).xyz;
  const project = (point: THREE.Node) => {
    const clip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(point, 1)));
    const ndc = clip.xy.div(max(clip.w, 0.0001));
    return vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)));
  };
  const depth0 = depthAt(screenUV);
  const floor0 = reconstruct(screenUV, depth0);
  const footprint = max(fwidth(p).length().mul(2), 0.025);
  const inside = (uv: THREE.Node) => uv.x.greaterThan(0.001).and(uv.x.lessThan(0.999)).and(uv.y.greaterThan(0.001)).and(uv.y.lessThan(0.999));
  const validHit = (uv: THREE.Node, world: THREE.Node, t: ReturnType<typeof float>) => {
    const delta = world.sub(p.add(ray.mul(t)));
    const tolerance = footprint.add(0.06);
    return inside(uv).and(world.y.lessThan(min(p.y, level).add(0.015)))
      .and(cameraViewMatrix.mul(vec4(world, 1)).z.lessThan(positionView.z))
      .and(delta.length().lessThan(tolerance)).and(t.greaterThan(0));
  };
  const planeCandidate = (uv: THREE.Node) => {
    const floor = reconstruct(uv, depthAt(uv));
    const floorNormal = normalize(cameraWorldMatrix.mul(vec4(texture(screen.normal, uv).level(float(0)).xyz, 0)).xyz);
    const denom = dot(ray, floorNormal);
    const t = clamp(dot(floor.sub(p), floorNormal).div(min(denom, -0.001)), 0, 12);
    const hitUv = project(p.add(ray.mul(t)));
    const world = reconstruct(clamp(hitUv, 0.001, 0.999), depthAt(clamp(hitUv, 0.001, 0.999)));
    return { uv: hitUv, t, valid: validHit(hitUv, world, t).and(denom.lessThan(-0.001)) };
  };
  const first = planeCandidate(screenUV);
  const second = planeCandidate(clamp(first.uv, 0.001, 0.999));
  const trace = Fn(() => {
    const result = vec4(screenUV, distance(p, floor0), 0).toVar();
    If(second.valid, () => { result.assign(vec4(second.uv, second.t, 1)); }).ElseIf(first.valid, () => {
      result.assign(vec4(first.uv, first.t, 1));
    }).Else(() => {
      const span = clamp(distance(p, floor0).mul(2), 0.1, 8);
      const previousT = float(0).toVar();
      const previousDelta = float(-0.001).toVar();
      const found = float(0).toVar();
      Loop({ start: 1, end: 17, type: 'int', condition: '<' }, ({ i }) => {
        If(found.equal(0), () => {
          const t = span.mul(float(i).div(16));
          const point = p.add(ray.mul(t));
          const uv = project(point);
          const world = reconstruct(clamp(uv, 0.001, 0.999), depthAt(clamp(uv, 0.001, 0.999)));
          const delta = cameraViewMatrix.mul(vec4(world.sub(point), 0)).z;
          If(inside(uv).and(previousDelta.lessThan(0)).and(delta.greaterThanEqual(0)).and(world.y.lessThan(level.add(0.015))), () => {
            const lo = previousT.toVar();
            const hi = t.toVar();
            Loop(4, () => {
              const mid = lo.add(hi).mul(0.5);
              const q = p.add(ray.mul(mid));
              const uvq = project(q);
              const seen = reconstruct(clamp(uvq, 0.001, 0.999), depthAt(clamp(uvq, 0.001, 0.999)));
              const crossed = cameraViewMatrix.mul(vec4(seen.sub(q), 0)).z.greaterThan(0);
              If(crossed, () => hi.assign(mid)).Else(() => lo.assign(mid));
            });
            const uvHit = project(p.add(ray.mul(hi)));
            const seen = reconstruct(clamp(uvHit, 0.001, 0.999), depthAt(clamp(uvHit, 0.001, 0.999)));
            If(validHit(uvHit, seen, hi), () => {
              result.assign(vec4(uvHit, hi, 1));
              found.assign(1);
            });
          });
          previousT.assign(t);
          previousDelta.assign(delta);
        });
      });
    });
    return result;
  })();
  const hitUv = trace.xy;
  const floorWorld = reconstruct(hitUv, depthAt(hitUv));
  const floorOutside = max(abs(floorWorld.x), abs(floorWorld.z)).greaterThan(half.add(0.05));
  const safeFloor = floorWorld.y.lessThan(min(p.y, level).add(0.02)).and(floorOutside.not());
  const distanceToBoundary = (axis: 'x' | 'z') => select(ray[axis].greaterThan(0), half.sub(p[axis]), half.negate().sub(p[axis])).div(select(abs(ray[axis]).greaterThan(0.0001), ray[axis], float(0.0001)));
  const boundaryT = clamp(min(abs(distanceToBoundary('x')), abs(distanceToBoundary('z'))), 0, 10);
  const pathLength = select(floorOutside, boundaryT, clamp(trace.z, 0, 10));
  const verticalDepth = select(floorOutside, float(2), max(level.sub(floorWorld.y), 0));
  const sceneColor = select(safeFloor, texture(screen.color, hitUv).rgb, vec3(0));
  return { floor0, floorWorld, pathLength, verticalDepth, sceneColor, confidence: trace.w };
}
