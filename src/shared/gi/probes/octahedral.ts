import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3 } from 'three/tsl';

export function octEncode(direction: THREE.Vector3, out = new THREE.Vector2()): THREE.Vector2 {
  const norm = Math.abs(direction.x) + Math.abs(direction.y) + Math.abs(direction.z) || 1;
  let x = direction.x / norm;
  let y = direction.y / norm;
  if (direction.z < 0) {
    const fx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    const fy = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
    x = fx; y = fy;
  }
  return out.set(x * 0.5 + 0.5, y * 0.5 + 0.5);
}

export function octDecode(u: number, v: number, out = new THREE.Vector3()): THREE.Vector3 {
  const x = u * 2 - 1;
  const y = v * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  const t = Math.max(-z, 0);
  out.set(x + (x >= 0 ? -t : t), y + (y >= 0 ? -t : t), z);
  return out.normalize();
}

export function texelDirection(texel: number, side: number, out = new THREE.Vector3()): THREE.Vector3 {
  const x = texel % side;
  const y = Math.floor(texel / side);
  return octDecode((x + 0.5) / side, (y + 0.5) / side, out);
}

export const octEncodeNode = Fn(([direction]: [THREE.Node]) => {
  const d = vec3(direction);
  const n = d.div(d.x.abs().add(d.y.abs()).add(d.z.abs()).max(1e-6));
  const folded = vec2(
    float(1).sub(n.y.abs()).mul(n.x.greaterThanEqual(0).select(1, -1)),
    float(1).sub(n.x.abs()).mul(n.y.greaterThanEqual(0).select(1, -1)),
  );
  const xy = n.z.lessThan(0).select(folded, n.xy);
  return xy.mul(0.5).add(0.5);
});

/* @important The one-texel border repeats the interior across the octahedral wrap (mirror on each edge,
   diagonal corners on the corners), so a bilinear fetch inside [1, side+1] texels never reads the
   neighbouring tile. Layout follows RTXGI's ProbeBlending border update. */
export function fillTileBorder(data: Float32Array, atlasWidth: number, tileX: number, tileY: number, side: number, channels: number): void {
  const tile = side + 2;
  const at = (x: number, y: number) => ((tileY * tile + y) * atlasWidth + tileX * tile + x) * channels;
  const copy = (dx: number, dy: number, sx: number, sy: number) => {
    const d = at(dx, dy); const s = at(sx, sy);
    for (let c = 0; c < channels; c++) data[d + c] = data[s + c];
  };
  for (let i = 1; i <= side; i++) {
    copy(i, 0, side + 1 - i, 1);
    copy(i, side + 1, side + 1 - i, side);
    copy(0, i, 1, side + 1 - i);
    copy(side + 1, i, side, side + 1 - i);
  }
  copy(0, 0, side, side);
  copy(side + 1, 0, 1, side);
  copy(0, side + 1, side, 1);
  copy(side + 1, side + 1, 1, 1);
}
