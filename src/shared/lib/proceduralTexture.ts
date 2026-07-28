import * as THREE from 'three';

/** Tileable multi-octave value noise, rendered to a canvas texture. */
export function makeNoiseTexture(opts: {
  size?: number;
  octaves?: number;
  baseFreq?: number;
  seed?: number;
  /** map noise n∈[0,1] to RGB */
  shade?: (n: number, x: number, y: number) => [number, number, number];
  repeat?: number;
} = {}): THREE.CanvasTexture {
  const size = opts.size ?? 512;
  const octaves = opts.octaves ?? 4;
  const baseFreq = opts.baseFreq ?? 8;
  const seed = opts.seed ?? 1;
  const shade = opts.shade ?? ((n) => [n * 255, n * 255, n * 255] as [number, number, number]);

  // hash-lattice value noise, indices wrapped mod frequency → truly seamless
  const hash2i = (x: number, y: number, s: number): number => {
    let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  const val = (u: number, v: number, freq: number): number => {
    const fx = u * freq;
    const fy = v * freq;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const w = (xi: number, yi: number) =>
      hash2i(((xi % freq) + freq) % freq, ((yi % freq) + freq) % freq, seed);
    const a = w(x0, y0), b = w(x0 + 1, y0), c = w(x0, y0 + 1), d = w(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let n = 0, amp = 0.5, norm = 0, f = baseFreq;
      for (let o = 0; o < octaves; o++) {
        n += amp * val(u, v, f);
        norm += amp;
        amp *= 0.5;
        f *= 2;
      }
      n /= norm;
      const [r, gg, b] = shade(n, u, v);
      const i = (y * size + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = gg;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  if (opts.repeat) tex.repeat.setScalar(opts.repeat);
  return tex;
}
