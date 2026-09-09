import { PNG } from 'pngjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const SOURCE_DIR = resolve(flag('in', 'art/sand'));
const OUT_DIR = resolve(flag('out', 'public/art/sand'));
const REFERENCE = resolve(flag('reference', 'concepts/beach.png'));

const LAYERS = [
  { name: 'dry-grain', reliefFrom: 'luminance', reliefContrast: 1.0, normalScale: 0.004, palette: 'dry' },
  { name: 'wind-ripples', reliefFrom: 'luminance', reliefContrast: 1.0, normalScale: 0.010, palette: 'dry' },
  { name: 'wet-sand', reliefFrom: 'luminance', reliefContrast: 0.5, normalScale: 0.002, palette: 'wet', brightness: 0.55, coolness: 0.94 },
  { name: 'shell-litter', reliefFrom: 'pieces', reliefContrast: 1.0, normalScale: 0.045, palette: null },
];

const REFERENCE_PATCHES = {
  dry: [1030, 555, 1160, 665],
  wet: [880, 600, 1010, 700],
};

const PATCH_SPREAD_GAIN = 1.5;

const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const luminanceOf = (rgb, i) => 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];

const readPng = (path) => PNG.sync.read(readFileSync(path));

function writeRgba(path, size, fill) {
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i++) fill(png.data, i * 4, i);
  writeFileSync(path, PNG.sync.write(png));
}

function torusPoisson(rhs, size, iterations = 240) {
  let current = new Float64Array(size * size);
  let next = new Float64Array(size * size);
  const at = (a, x, y) => a[((y + size) % size) * size + ((x + size) % size)];
  for (let step = 0; step < iterations; step++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const neighbours = at(current, x + 1, y) + at(current, x - 1, y) + at(current, x, y + 1) + at(current, x, y - 1);
        next[y * size + x] = (neighbours - rhs[y * size + x]) / 4;
      }
    }
    [current, next] = [next, current];
  }
  return current;
}

/**
 * @important Moisan's periodic/smooth decomposition. Blending a border band to hide
 * the seam smears the grain exactly where the eye lands when the map repeats; the
 * periodic component tiles by construction and leaves the detail alone.
 */
function periodicComponent(channel, size) {
  const boundary = new Float64Array(size * size);
  for (let x = 0; x < size; x++) {
    const top = channel[x];
    const bottom = channel[(size - 1) * size + x];
    boundary[x] += bottom - top;
    boundary[(size - 1) * size + x] += top - bottom;
  }
  for (let y = 0; y < size; y++) {
    const left = channel[y * size];
    const right = channel[y * size + size - 1];
    boundary[y * size] += right - left;
    boundary[y * size + size - 1] += left - right;
  }
  const smooth = torusPoisson(boundary, size);
  const mean = smooth.reduce((sum, value) => sum + value, 0) / smooth.length;
  const periodic = new Float64Array(size * size);
  for (let i = 0; i < periodic.length; i++) periodic[i] = channel[i] - (smooth[i] - mean);
  return periodic;
}

function seamError(channel, size) {
  let sum = 0;
  for (let i = 0; i < size; i++) {
    sum += Math.abs(channel[i * size] - channel[i * size + size - 1]);
    sum += Math.abs(channel[i] - channel[(size - 1) * size + i]);
  }
  return sum / (2 * size);
}

function referenceStats(patchName) {
  const png = readPng(REFERENCE);
  const [x0, y0, x1, y1] = REFERENCE_PATCHES[patchName];
  const sums = [0, 0, 0];
  const squares = [0, 0, 0];
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * png.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const value = srgbToLinear(png.data[o + c] / 255);
        sums[c] += value;
        squares[c] += value * value;
      }
      count++;
    }
  }
  const mean = sums.map((sum) => sum / count);
  const std = squares.map((square, c) => Math.sqrt(Math.max(1e-6, square / count - mean[c] * mean[c])));
  return { mean, std };
}

function matchPalette(rgb, size, target) {
  const count = size * size;
  for (let c = 0; c < 3; c++) {
    let mean = 0;
    for (let i = 0; i < count; i++) mean += rgb[i * 3 + c];
    mean /= count;
    let variance = 0;
    for (let i = 0; i < count; i++) variance += (rgb[i * 3 + c] - mean) ** 2;
    const spread = Math.sqrt(Math.max(1e-6, variance / count));
    const gain = (target.std[c] * PATCH_SPREAD_GAIN) / spread;
    for (let i = 0; i < count; i++) rgb[i * 3 + c] = clamp01((rgb[i * 3 + c] - mean) * gain + target.mean[c]);
  }
}

/**
 * @important A wet-sand reference patch photographed at the surf line already
 * carries foam and sun on it, so calibrating to it makes wet sand LIGHTER than
 * dry. Wetted grains return roughly half the light and a little less red.
 */
function applyWetting(rgb, size, brightness, coolness) {
  for (let i = 0; i < size * size; i++) {
    rgb[i * 3] = clamp01(rgb[i * 3] * brightness * coolness);
    rgb[i * 3 + 1] = clamp01(rgb[i * 3 + 1] * brightness);
    rgb[i * 3 + 2] = clamp01(rgb[i * 3 + 2] * brightness * (2 - coolness));
  }
}

function pieceMask(rgb, size) {
  const count = size * size;
  const luminance = new Float64Array(count);
  for (let i = 0; i < count; i++) luminance[i] = luminanceOf(rgb, i);
  const sorted = Float64Array.from(luminance).sort();
  const median = sorted[Math.floor(count / 2)];
  const spread = (sorted[Math.floor(count * 0.84)] - sorted[Math.floor(count * 0.16)]) || 1e-3;
  const mask = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const brightnessOff = Math.abs(luminance[i] - median) / spread - 0.9;
    const chroma = Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) - Math.min(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    const chromaOff = Math.abs(chroma - 0.12) / 0.12 - 1.2;
    mask[i] = clamp01(Math.max(brightnessOff, chromaOff) * 0.9);
  }
  return mask;
}

/**
 * @important Ties share a rank. A scatter map is mostly empty, and ranking equal
 * values by their position in the sort spreads those zeros over the whole range:
 * a cut at 1 - density then lands among the empty texels.
 */
function rankField(field) {
  const order = Array.from({ length: field.length }, (_, i) => i).sort((a, b) => field[a] - field[b]);
  const rank = new Float64Array(field.length);
  const last = Math.max(1, field.length - 1);
  let group = 0;
  for (let i = 0; i < order.length; i++) {
    if (field[order[i]] !== field[order[group]]) group = i;
    rank[order[i]] = group / last;
  }
  return rank;
}

function tangentNormals(height, size, scale) {
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  const encoded = { x: new Float64Array(size * size), y: new Float64Array(size * size) };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * scale * size;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * scale * size;
      const inverse = 1 / Math.hypot(dx, dy, 1);
      encoded.x[y * size + x] = -dx * inverse * 0.5 + 0.5;
      encoded.y[y * size + x] = -dy * inverse * 0.5 + 0.5;
    }
  }
  return encoded;
}

function loadLinearRgb(path) {
  const png = readPng(path);
  const size = Math.min(png.width, png.height);
  const rgb = new Float64Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const source = (y * png.width + x) * 4;
      const target = (y * size + x) * 3;
      for (let c = 0; c < 3; c++) rgb[target + c] = srgbToLinear(png.data[source + c] / 255);
    }
  }
  return { rgb, size };
}

function makeSeamless(rgb, size, layerName) {
  for (let c = 0; c < 3; c++) {
    const channel = new Float64Array(size * size);
    for (let i = 0; i < size * size; i++) channel[i] = rgb[i * 3 + c];
    const before = seamError(channel, size);
    const periodic = periodicComponent(channel, size);
    const after = seamError(periodic, size);
    for (let i = 0; i < size * size; i++) rgb[i * 3 + c] = clamp01(periodic[i]);
    if (c === 0) console.log(`· ${layerName}: seam ${before.toFixed(4)} → ${after.toFixed(4)}`);
  }
}

function reliefOf(rgb, size, layer) {
  const count = size * size;
  const raw = new Float64Array(count);
  if (layer.reliefFrom === 'pieces') raw.set(pieceMask(rgb, size));
  else for (let i = 0; i < count; i++) raw[i] = luminanceOf(rgb, i);
  let low = Infinity;
  let high = -Infinity;
  for (const value of raw) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const height = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const normalised = (raw[i] - low) / Math.max(1e-4, high - low);
    height[i] = clamp01(0.5 + (normalised - 0.5) * layer.reliefContrast * 2);
  }
  return { height, presence: layer.reliefFrom === 'pieces' ? raw : height };
}

function buildLayer(layer) {
  const source = `${SOURCE_DIR}/${layer.name}.png`;
  if (!existsSync(source)) {
    console.log(`· ${layer.name}: no ${source}, skipped`);
    return;
  }
  const { rgb, size } = loadLinearRgb(source);
  makeSeamless(rgb, size, layer.name);
  if (layer.palette) matchPalette(rgb, size, referenceStats(layer.palette));
  if (layer.brightness) applyWetting(rgb, size, layer.brightness, layer.coolness ?? 1);
  const { height, presence } = reliefOf(rgb, size, layer);
  const coverage = rankField(presence);
  const normals = tangentNormals(height, size, layer.normalScale);

  mkdirSync(OUT_DIR, { recursive: true });
  writeRgba(`${OUT_DIR}/${layer.name}-surface.png`, size, (data, o, i) => {
    for (let c = 0; c < 3; c++) data[o + c] = Math.round(linearToSrgb(clamp01(rgb[i * 3 + c])) * 255);
    data[o + 3] = Math.round(height[i] * 255);
  });
  writeRgba(`${OUT_DIR}/${layer.name}-detail.png`, size, (data, o, i) => {
    data[o] = Math.round(normals.x[i] * 255);
    data[o + 1] = Math.round(normals.y[i] * 255);
    data[o + 2] = Math.round(coverage[i] * 255);
    data[o + 3] = 255;
  });
  console.log(`· ${layer.name}: ${size}px → surface + detail`);
}

for (const layer of LAYERS) buildLayer(layer);
console.log(`→ ${OUT_DIR}`);
