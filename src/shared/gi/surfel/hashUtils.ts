// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
import { Fn, uint, bitcast } from 'three/tsl';
import * as THREE from 'three/webgpu';
// uint hash1(uint x)
export const hash1 = Fn(([x_in]: [number]) => {
  let x = uint(x_in).toVar();

  // x += (x << 10u);
  x.addAssign(x.shiftLeft(10));
  // x ^= (x >>  6u);
  x.bitXorAssign(x.shiftRight(6));
  // x += (x <<  3u);
  x.addAssign(x.shiftLeft(3));
  // x ^= (x >> 11u);
  x.bitXorAssign(x.shiftRight(11));
  // x += (x << 15u);
  x.addAssign(x.shiftLeft(15));

  return x;
});

export const hash1_mut = Fn(([h]: [THREE.Node]) => {
  // 1. uint res = h;
  // We create a new Var 'res' to hold the current value of h.
  // wrapping in uint() ensures type consistency, .toVar() creates the register.
  const res = uint(h).toVar();

  // 2. h = hash1(h);
  // We update the input variable 'h' with its new hashed value.
  h.assign(hash1(h));

  // 3. return res;
  return res;
});
// uint hash_combine2(uint x, uint y)
export const hashCombine2 = Fn(([x, y]: [THREE.Node, THREE.Node]) => {
  const M = uint(1664525);
  const C = uint(1013904223);

  // uint seed = (x * M + y + C) * M;
  let seed = x.mul(M).add(y).add(C).mul(M).toVar();

  // Tempering (from Matsumoto)
  // seed ^= (seed >> 11u);
  seed.bitXorAssign(seed.shiftRight(11));
  // seed ^= (seed << 7u) & 0x9d2c5680u;
  seed.bitXorAssign(seed.shiftLeft(7).bitAnd(uint(0x9d2c5680)));
  // seed ^= (seed << 15u) & 0xefc60000u;
  seed.bitXorAssign(seed.shiftLeft(15).bitAnd(uint(0xefc60000)));
  // seed ^= (seed >> 18u);
  seed.bitXorAssign(seed.shiftRight(18));

  return seed;
});

// uint hash2(uint2 v)
export const hash2 = Fn(([v]: [THREE.Node]) => {
  return hashCombine2(v.x, hash1(v.y));
});

// uint hash3(uint3 v)
export const hash3 = Fn(([v]: [THREE.Node]) => {
  // hash_combine2(v.x, hash2(v.yz))
  return hashCombine2(v.x, hash2(v.yz));
});

// uint hash4(uint4 v)
export const hash4 = Fn(([v]: [THREE.Node]) => {
  // hash_combine2(v.x, hash3(v.yzw))
  return hashCombine2(v.x, hash3(v.yzw));
});

// float uint_to_u01_float(uint h)
export const uintToU01Float = Fn(([h_in]: [number]) => {
  let h = uint(h_in).toVar();
  const mantissaMask = uint(0x007fffff);
  const one = uint(0x3f800000);

  // h &= mantissaMask;
  h.bitAndAssign(mantissaMask);
  // h |= one;
  h.bitOrAssign(one);

  // float r2 = asfloat( h );
  const r2 = bitcast(h, 'float');

  // return r2 - 1.0;
  return r2.sub(1.0);
});

// Helper to mutate a seed similar to hash1_mut
// TSL passes by value, so we just return the new seed.
// Usage: seed.assign(hash1(seed));
