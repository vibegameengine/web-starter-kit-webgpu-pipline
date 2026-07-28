// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
import {
  Fn,
  float,
  uint,
  vec3,
  struct,
  bitcast,
  clamp,
  normalize,
} from 'three/tsl';
import * as THREE from 'three/webgpu';

export const VertexPacked = struct(
  {
    data0: 'vec4',
  },
  'VertexPacked',
);

export const Vertex = struct(
  {
    position: 'vec3',
    normal: 'vec3',
  },
  'Vertex',
);

export const pack_unorm = Fn(([val, bitCount]: [THREE.Node, THREE.Node]) => {
  const maxVal = uint(1).shiftLeft(bitCount).sub(1);
  return uint(clamp(val, 0.0, 1.0).mul(float(maxVal)));
});

export const unpack_unorm = Fn(([pckd, bitCount]: [THREE.Node, THREE.Node]) => {
  const maxVal = uint(1).shiftLeft(bitCount).sub(1);
  return float(pckd.bitAnd(maxVal)).div(float(maxVal));
});

export const pack_normal_11_10_11 = Fn(([n]: [THREE.Node]) => {
  const pckd = uint(0).toVar();

  pckd.addAssign(pack_unorm(n.x.mul(0.5).add(0.5), 11));
  pckd.addAssign(pack_unorm(n.y.mul(0.5).add(0.5), 10).shiftLeft(11));
  pckd.addAssign(pack_unorm(n.z.mul(0.5).add(0.5), 11).shiftLeft(21));

  return bitcast(pckd, 'float');
});

export const unpack_unit_direction_11_10_11 = Fn(([pck]: [THREE.Node]) => {
  // Constants for 11, 10, 11 bit masks and divisors
  const mask11 = uint(2047); // (1<<11)-1
  const mask10 = uint(1023); // (1<<10)-1
  const div11 = float(2047.0);
  const div10 = float(1023.0);

  const x = float(pck.bitAnd(mask11)).mul(2.0).div(div11).sub(1.0);
  const y = float(pck.shiftRight(11).bitAnd(mask10))
    .mul(2.0)
    .div(div10)
    .sub(1.0);
  const z = float(pck.shiftRight(21)).mul(2.0).div(div11).sub(1.0);

  return vec3(x, y, z);
});

export const unpack_normal_11_10_11 = Fn(([pckd]: [THREE.Node]) => {
  const p = bitcast(pckd, 'uint');
  return normalize(unpack_unit_direction_11_10_11(p));
});

export const unpack_vertex = Fn(([p]: [THREE.Node]) => {
  const res = Vertex();
  res.get('position').assign(p.get('data0').xyz);
  // Use asuint equivalent (bitcast) to unpack normal from float w
  res
    .get('normal')
    .assign(unpack_unit_direction_11_10_11(bitcast(p.get('data0').w, 'uint')));
  return res;
});

export const pack_vertex = Fn(([v]: [THREE.Node]) => {
  const p = VertexPacked();
  p.get('data0').xyz.assign(v.get('position'));
  p.get('data0').w.assign(pack_normal_11_10_11(v.get('normal')));
  return p;
});
