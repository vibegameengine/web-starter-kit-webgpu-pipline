import * as THREE from 'three/webgpu';
import { float, int, mix, uint, uniformArray, vec3, vec4 } from 'three/tsl';
import type { FaceLayout } from './reflectionTypes.ts';

type N = THREE.Node;
type UniformArray = ReturnType<typeof uniformArray>;

export interface ChainReader {
  layout: FaceLayout;
  slots: number;
  radiance: THREE.StorageBufferNode;
  offsets: UniformArray;
}

export interface ProbeAddress {
  slot: N;
  bank: N;
}

export interface ProxyBounds {
  anchor: N;
  center: N;
  halfSize: N;
}

export function faceOfDirection(direction: N): N {
  const d = vec3(direction);
  const a = d.abs();
  const ma = a.x.max(a.y).max(a.z).max(1e-8);
  const isX = a.x.greaterThanEqual(a.y).and(a.x.greaterThanEqual(a.z));
  const isY = isX.not().and(a.y.greaterThanEqual(a.z));
  const faceX = d.x.greaterThan(0).select(float(0), float(1));
  const faceY = d.y.greaterThan(0).select(float(2), float(3));
  const faceZ = d.z.greaterThan(0).select(float(4), float(5));
  const sX = d.x.greaterThan(0).select(d.z.negate(), d.z).div(ma);
  const sY = d.x.div(ma);
  const sZ = d.z.greaterThan(0).select(d.x, d.x.negate()).div(ma);
  const tY = d.y.greaterThan(0).select(d.z, d.z.negate()).div(ma);
  const tOther = d.y.negate().div(ma);
  const face = isX.select(faceX, isY.select(faceY, faceZ));
  const s = isX.select(sX, isY.select(sY, sZ));
  const t = isY.select(tY, tOther);
  return vec3(face, s, t);
}

export function directionOfFace(face: N, s: N, t: N): N {
  const f = float(face);
  const pick = f.lessThan(0.5).select(vec3(1, t.negate(), s.negate()),
    f.lessThan(1.5).select(vec3(-1, t.negate(), s),
      f.lessThan(2.5).select(vec3(s, 1, t),
        f.lessThan(3.5).select(vec3(s, -1, t.negate()),
          f.lessThan(4.5).select(vec3(s, t.negate(), 1), vec3(s.negate(), t.negate(), -1))))));
  return vec3(pick).normalize();
}

export function texelOfFace(face: N, ix: N, iy: N, side: N): N {
  const sideF = float(side);
  const inside = float(ix).greaterThanEqual(0).and(float(iy).greaterThanEqual(0))
    .and(float(ix).lessThan(sideF)).and(float(iy).lessThan(sideF));
  const direct = float(face).mul(sideF).mul(sideF).add(float(iy).mul(sideF)).add(float(ix));
  const s = float(ix).add(0.5).div(sideF).mul(2).sub(1);
  const t = float(iy).add(0.5).div(sideF).mul(2).sub(1);
  const wrapped = faceOfDirection(directionOfFace(float(face), s, t));
  const wx = wrapped.y.mul(0.5).add(0.5).mul(sideF).floor().clamp(0, sideF.sub(1));
  const wy = wrapped.z.mul(0.5).add(0.5).mul(sideF).floor().clamp(0, sideF.sub(1));
  const neighbour = wrapped.x.mul(sideF).mul(sideF).add(wy.mul(sideF)).add(wx);
  return uint(inside.select(direct, neighbour));
}

export function mipOffsetArray(layout: FaceLayout): UniformArray {
  return uniformArray(layout.mipOffsets.map((offset) => offset));
}

export function levelSide(layout: FaceLayout, level: N): N {
  return float(layout.faceSize).mul(float(level).negate().exp2()).max(1);
}

export function fetchLevel(reader: ChainReader, address: ProbeAddress, level: N, direction: N): N {
  const { layout, slots, radiance, offsets } = reader;
  const side = levelSide(layout, level);
  const ft = faceOfDirection(direction);
  const face = ft.x;
  const fx = ft.y.mul(0.5).add(0.5).mul(side).sub(0.5);
  const fy = ft.z.mul(0.5).add(0.5).mul(side).sub(0.5);
  const x0 = fx.floor();
  const y0 = fy.floor();
  const wx = fx.sub(x0);
  const wy = fy.sub(y0);
  const base = float(address.bank).mul(slots).add(float(address.slot)).mul(layout.chainTexels)
    .add(offsets.element(int(level)));
  const corner = (dx: number, dy: number): N =>
    vec4((radiance as unknown as { element: (index: N) => N }).element(
      uint(base).add(texelOfFace(face, float(x0).add(dx), float(y0).add(dy), side)),
    )).rgb;
  const top = mix(corner(0, 0), corner(1, 0), wx);
  const bottom = mix(corner(0, 1), corner(1, 1), wx);
  return mix(top, bottom, wy);
}

export function fetchRoughness(reader: ChainReader, address: ProbeAddress, roughness: N, direction: N): N {
  const maxLevel = reader.layout.levels - 1;
  const scaled = float(roughness).clamp(0, 1).mul(maxLevel);
  const low = scaled.floor();
  const high = low.add(1).min(maxLevel);
  const blend = scaled.sub(low);
  const a = fetchLevel(reader, address, low, direction);
  const b = fetchLevel(reader, address, high, direction);
  return mix(a, b, blend);
}

export function boxDirection(proxy: ProxyBounds, position: N, reflected: N): N {
  const local = vec3(position).sub(proxy.center);
  const dir = vec3(reflected);
  const safe = vec3(
    dir.x.abs().lessThan(1e-6).select(float(1e-6), dir.x),
    dir.y.abs().lessThan(1e-6).select(float(1e-6), dir.y),
    dir.z.abs().lessThan(1e-6).select(float(1e-6), dir.z),
  );
  const half = vec3(proxy.halfSize);
  const first = half.sub(local).div(safe);
  const second = half.negate().sub(local).div(safe);
  const exit = vec3(first.x.max(second.x), first.y.max(second.y), first.z.max(second.z));
  const distance = exit.x.min(exit.y).min(exit.z);
  const hit = vec3(position).add(dir.mul(distance.max(0)));
  return vec4(vec3(hit).sub(proxy.anchor).normalize(), distance);
}

const TAP_PATTERN = [
  new THREE.Vector2(0, 0),
  new THREE.Vector2(-0.25, -0.25), new THREE.Vector2(0.25, -0.25),
  new THREE.Vector2(-0.25, 0.25), new THREE.Vector2(0.25, 0.25),
  new THREE.Vector2(-0.375, 0), new THREE.Vector2(0.375, 0), new THREE.Vector2(0, 0.375),
];

export function tapOffsetArray(): UniformArray {
  return uniformArray(TAP_PATTERN);
}
