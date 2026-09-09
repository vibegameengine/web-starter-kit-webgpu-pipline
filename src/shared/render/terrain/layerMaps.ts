import * as THREE from 'three/webgpu';

/**
 * A layer's maps, as the two RGBA textures the layered surface reads.
 *
 * Two, and plain 2D, for one reason each:
 *
 * · TWO, not four. Albedo, relief, coverage and normal are seven channels, and
 *   every one of them has to be read through the same stochastic turn and offset
 *   as the others. Packed as `surface` = albedo.rgb + height.a and `detail` =
 *   normal.xy + coverage.z, one cell costs two taps instead of four, and the
 *   normal's z comes back from its own x and y.
 *
 * · 2D, not a `DataArrayTexture`. Three's WGSL builder drops the array layer when
 *   a sample takes explicit gradients (`generateTextureGrad`, its own TODO), so
 *   an array slice can be read EITHER by layer OR with a controlled footprint,
 *   not both — and without the gradients a stochastic uv reads the smallest mip
 *   it owns at every cell border and the ground crawls with white sparkle.
 */

export interface LayerSlice {
  /** Linear 0..1 albedo, three floats per texel, row-major. */
  readonly albedo: Float32Array;
  /** 0..1 relief. Drives the height blend, parallax and the contact shadow. */
  readonly height: Float32Array;
  /**
   * What this layer's stones ARE, before ranking, 0..1. Only overlays need it:
   * the packed coverage channel is the RANK of this field, so cutting at
   * 1 - density covers exactly that fraction of the ground.
   */
  readonly presence?: Float32Array;
  /** Height-to-normal gain: the layer's relief in metres over its tile in metres. */
  readonly normalScale?: number;
}

export interface LayerTextures {
  /** rgb = albedo (sRGB), a = relief. */
  readonly surface: THREE.DataTexture;
  /** xy = tangent-space normal, z = ranked coverage. */
  readonly detail: THREE.DataTexture;
}

export interface LayerMaps {
  readonly layers: readonly LayerTextures[];
  readonly size: number;
  dispose(): void;
}

/**
 * The fraction of the field lying below each texel, 0..1.
 *
 * A threshold on a raw noise field covers an unknown share of the ground, so the
 * author feels one out by eye and re-feels it whenever the map is redrawn. On the
 * rank, `1 - density` covers exactly `density` of it, by construction.
 */
export function rankField(field: Float32Array): Float32Array {
  const order = Array.from({ length: field.length }, (_, i) => i).sort((a, b) => field[a] - field[b]);
  const rank = new Float32Array(field.length);
  const last = Math.max(1, field.length - 1);
  // TIES SHARE A RANK. A scatter map is mostly empty, and ranking equal values by
  // their position in the sort spreads those zeros evenly over the whole 0..1
  // range: a cut at 1 - density then lands in the middle of the empty texels and
  // covers the ground in pale blobs instead of the stated fraction of stones.
  let group = 0;
  for (let i = 0; i < order.length; i++) {
    if (field[order[i]] !== field[order[group]]) group = i;
    rank[order[i]] = group / last;
  }
  return rank;
}

const toSrgbByte = (linear: number): number => {
  const c = Math.min(1, Math.max(0, linear));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
};

const byte = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255);

function makeTexture(data: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

/** Tangent-space normal from a tiling height field, wrapped at the edges. */
function writeNormals(detail: Uint8Array, height: Float32Array, size: number, scale: number): void {
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * scale * size;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * scale * size;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      detail[i] = byte(-dx * inv * 0.5 + 0.5);
      detail[i + 1] = byte(-dy * inv * 0.5 + 0.5);
    }
  }
}

function packSlice(slice: LayerSlice, size: number): LayerTextures {
  const texels = size * size;
  const surface = new Uint8Array(texels * 4);
  const detail = new Uint8Array(texels * 4);
  const coverage = rankField(slice.presence ?? slice.height);
  for (let i = 0; i < texels; i++) {
    surface[i * 4] = toSrgbByte(slice.albedo[i * 3]);
    surface[i * 4 + 1] = toSrgbByte(slice.albedo[i * 3 + 1]);
    surface[i * 4 + 2] = toSrgbByte(slice.albedo[i * 3 + 2]);
    surface[i * 4 + 3] = byte(slice.height[i]);
    detail[i * 4 + 2] = byte(coverage[i]);
    detail[i * 4 + 3] = 255;
  }
  writeNormals(detail, slice.height, size, slice.normalScale ?? 1);
  return { surface: makeTexture(surface, size, true), detail: makeTexture(detail, size, false) };
}

/** Pack the slices into one pair of textures each. Albedo is written back through sRGB. */
export function buildLayerMaps(slices: readonly LayerSlice[], size: number): LayerMaps {
  const layers = slices.map((slice) => packSlice(slice, size));
  return {
    layers,
    size,
    dispose: () => layers.forEach(({ surface, detail }) => {
      surface.dispose();
      detail.dispose();
    }),
  };
}
