import * as THREE from 'three';

/**
 * Hand-drawn-on-canvas organic texture set for the forest:
 * ridged conifer bark (albedo + normal), needle-cluster branch cards,
 * fern fronds, and needle-litter ground. All deterministic.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas2d(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

function toTexture(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Sobel height→normal map (input canvas treated as height in luminance). */
function heightToNormal(src: HTMLCanvasElement, strength = 2.0): THREE.CanvasTexture {
  const size = src.width;
  const g = src.getContext('2d')!;
  const h = g.getImageData(0, 0, size, size).data;
  const [out, og] = canvas2d(size);
  const img = og.createImageData(size, size);
  const lum = (x: number, y: number) => {
    const xi = ((x % size) + size) % size;
    const yi = ((y % size) + size) % size;
    const i = (yi * size + xi) * 4;
    return (h[i] + h[i + 1] + h[i + 2]) / (3 * 255);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (lum(x + 1, y) - lum(x - 1, y)) * strength;
      const dy = (lum(x, y + 1) - lum(x, y - 1)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = (-dx * inv * 0.5 + 0.5) * 255;
      img.data[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      img.data[i + 2] = inv * 255;
      img.data[i + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  return toTexture(out, false);
}

// ── bark ─────────────────────────────────────────────────────────────────────
export interface BarkSet { map: THREE.CanvasTexture; normalMap: THREE.CanvasTexture }

/**
 * Redwood/pine bark: long vertical fibrous ridges with deep fissures.
 * Drawn as many overlapping vertical strokes with jitter, then cracked.
 */
export function makeBark(seed = 3, tone: 'redwood' | 'pine' = 'redwood'): BarkSet {
  const size = 512;
  const rand = mulberry32(seed);
  const [c, g] = canvas2d(size);

  const base = tone === 'redwood' ? [118, 68, 46] : [104, 88, 70];
  g.fillStyle = `rgb(${base[0] * 0.55},${base[1] * 0.55},${base[2] * 0.55})`;
  g.fillRect(0, 0, size, size);

  // fibrous ridges: vertical wandering strokes, wrap horizontally
  for (let i = 0; i < 900; i++) {
    const x0 = rand() * size;
    const w = 2 + rand() * 7;
    const bright = 0.55 + rand() * 0.85;
    const r = Math.min(255, base[0] * bright);
    const gg = Math.min(255, base[1] * bright);
    const b = Math.min(255, base[2] * bright);
    g.strokeStyle = `rgba(${r},${gg},${b},${0.25 + rand() * 0.4})`;
    g.lineWidth = w;
    g.lineCap = 'round';
    for (const wrap of [0, -size, size]) {
      g.beginPath();
      let x = x0 + wrap;
      // draw taller than the tile so vertical wrap is seamless
      for (let y = -40; y <= size + 40; y += 14) {
        x += (rand() - 0.5) * 6;
        if (y <= -40) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
  }

  // deep fissures
  for (let i = 0; i < 60; i++) {
    const x0 = rand() * size;
    g.strokeStyle = `rgba(12,7,5,${0.35 + rand() * 0.4})`;
    g.lineWidth = 1.5 + rand() * 3.5;
    for (const wrap of [0, -size, size]) {
      g.beginPath();
      let x = x0 + wrap;
      for (let y = -40; y <= size + 40; y += 18) {
        x += (rand() - 0.5) * 10;
        if (y <= -40) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
  }

  // horizontal breaks (bark plates)
  for (let i = 0; i < 90; i++) {
    const y = rand() * size;
    const x = rand() * size;
    const len = 12 + rand() * 44;
    g.strokeStyle = `rgba(15,9,6,${0.15 + rand() * 0.3})`;
    g.lineWidth = 1 + rand() * 2;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + len, y + (rand() - 0.5) * 8);
    g.stroke();
  }

  return { map: toTexture(c), normalMap: heightToNormal(c, 2.6) };
}

// ── needle branch card ───────────────────────────────────────────────────────
/**
 * A conifer branch silhouette on transparent background: central twig with
 * side twigs, all densely covered in short needle strokes. Used on crossed
 * cards; alphaTest cuts the sprite out.
 */
export function makeNeedleCard(seed = 7): THREE.CanvasTexture {
  const size = 512;
  const rand = mulberry32(seed);
  const [c, g] = canvas2d(size);
  g.clearRect(0, 0, size, size);

  const needleColor = () => {
    const h = 96 + rand() * 36;      // green hues
    const s = 52 + rand() * 26;
    const l = 8 + rand() * 10;
    return `hsla(${h},${s}%,${l}%,${0.85 + rand() * 0.15})`;
  };

  // main twig from bottom-center to top
  const drawTwig = (
    x0: number, y0: number, x1: number, y1: number,
    needleLen: number, depth: number,
  ) => {
    const steps = 26;
    g.strokeStyle = 'rgba(60,42,30,0.85)';
    g.lineWidth = Math.max(1, 3 - depth);
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();

    const dx = (x1 - x0) / steps;
    const dy = (y1 - y0) / steps;
    const ang = Math.atan2(dy, dx);
    for (let i = 2; i <= steps; i++) {
      const px = x0 + dx * i;
      const py = y0 + dy * i;
      const taper = 1 - (i / steps) * 0.4;
      for (let n = 0; n < 4; n++) {
        const side = rand() > 0.5 ? 1 : -1;
        const na = ang + side * (0.5 + rand() * 0.9);
        const nl = needleLen * taper * (0.55 + rand() * 0.75);
        g.strokeStyle = needleColor();
        g.lineWidth = 1.8;
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px + Math.cos(na) * nl, py + Math.sin(na) * nl);
        g.stroke();
      }
    }

    // side twigs
    if (depth < 2) {
      const branches = 5 + Math.floor(rand() * 3);
      for (let b = 0; b < branches; b++) {
        const t = 0.25 + (b / branches) * 0.65;
        const bx = x0 + (x1 - x0) * t;
        const by = y0 + (y1 - y0) * t;
        const side = b % 2 === 0 ? 1 : -1;
        const ba = ang + side * (0.7 + rand() * 0.5);
        const bl = (1 - t) * 150 * (0.7 + rand() * 0.5);
        drawTwig(bx, by, bx + Math.cos(ba) * bl, by + Math.sin(ba) * bl, needleLen * 0.85, depth + 1);
      }
    }
  };

  drawTwig(size / 2, size - 8, size / 2 + (rand() - 0.5) * 40, 24, 30, 0);
  // two extra fans from the base fill the card's lower corners
  drawTwig(size / 2, size - 8, size * 0.16, size * 0.42, 26, 1);
  drawTwig(size / 2, size - 8, size * 0.84, size * 0.40, 26, 1);

  const t = toTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// ── fern frond ───────────────────────────────────────────────────────────────
export function makeFern(seed = 11): THREE.CanvasTexture {
  const size = 512;
  const rand = mulberry32(seed);
  const [c, g] = canvas2d(size);
  g.clearRect(0, 0, size, size);

  // stem: gentle arc from bottom-center to top
  const N = 46;
  const pts: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = size / 2 + Math.sin(t * 0.9) * size * 0.16;
    const y = size - 6 - t * (size - 30);
    pts.push([x, y]);
  }
  g.strokeStyle = 'rgba(72,96,38,0.95)';
  g.lineWidth = 3.4;
  g.beginPath();
  g.moveTo(...pts[0]);
  for (const p of pts) g.lineTo(...p);
  g.stroke();

  // pinnae: paired FILLED serrated blades — lush and overlapping
  for (let i = 2; i < N - 1; i++) {
    const t = i / N;
    const [px, py] = pts[i];
    const [qx, qy] = pts[i + 1];
    const ang = Math.atan2(qy - py, qx - px);
    const len = (1 - t) * size * 0.24 * (0.9 + rand() * 0.25) + 8;
    for (const side of [-1, 1]) {
      const pa = ang + side * (1.2 + rand() * 0.2);
      const tipX = px + Math.cos(pa) * len;
      const tipY = py + Math.sin(pa) * len;
      const light = 0.8 + rand() * 0.55;
      const grad = g.createLinearGradient(px, py, tipX, tipY);
      grad.addColorStop(0, `rgba(${48 * light},${88 * light},${30 * light},0.98)`);
      grad.addColorStop(1, `rgba(${76 * light},${128 * light},${46 * light},0.95)`);
      g.fillStyle = grad;
      const w0 = len * 0.16 + 3; // half-width at base
      const nx = Math.cos(pa + Math.PI / 2);
      const ny = Math.sin(pa + Math.PI / 2);
      g.beginPath();
      g.moveTo(px, py);
      const lobes = Math.max(4, Math.floor(len / 12));
      for (let s = 1; s <= lobes; s++) {
        const st = s / lobes;
        const cx = px + (tipX - px) * st;
        const cy = py + (tipY - py) * st;
        const w = w0 * (1 - st * 0.85) * (s % 2 === 0 ? 1.0 : 0.72);
        g.lineTo(cx + nx * w, cy + ny * w);
      }
      for (let s = lobes; s >= 1; s--) {
        const st = s / lobes;
        const cx = px + (tipX - px) * st;
        const cy = py + (tipY - py) * st;
        const w = w0 * (1 - st * 0.85) * (s % 2 === 0 ? 1.0 : 0.72);
        g.lineTo(cx - nx * w, cy - ny * w);
      }
      g.closePath();
      g.fill();
    }
  }

  const t = toTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// ── forest-floor litter ──────────────────────────────────────────────────────
export interface LitterSet { map: THREE.CanvasTexture; normalMap: THREE.CanvasTexture }

/** Needle litter + dirt + moss patches for the ground plane. Tileable. */
export function makeLitter(seed = 19): LitterSet {
  const size = 512;
  const rand = mulberry32(seed);
  const [c, g] = canvas2d(size);

  g.fillStyle = 'rgb(128,100,72)';
  g.fillRect(0, 0, size, size);

  // dirt blotches
  for (let i = 0; i < 260; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 8 + rand() * 34;
    const v = 0.7 + rand() * 0.7;
    g.fillStyle = `rgba(${132 * v},${100 * v},${68 * v},0.30)`;
    for (const wx of [0, -size, size]) {
      for (const wy of [0, -size, size]) {
        g.beginPath();
        g.ellipse(x + wx, y + wy, r, r * (0.5 + rand() * 0.5), rand() * Math.PI, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  // fallen needles: short thin strokes, russet
  for (let i = 0; i < 5200; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const a = rand() * Math.PI;
    const l = 4 + rand() * 9;
    const v = 0.65 + rand() * 0.9;
    g.strokeStyle = `rgba(${178 * v},${120 * v},${64 * v},${0.35 + rand() * 0.4})`;
    g.lineWidth = 1;
    for (const wx of [0, -size, size]) {
      for (const wy of [0, -size, size]) {
        g.beginPath();
        g.moveTo(x + wx, y + wy);
        g.lineTo(x + wx + Math.cos(a) * l, y + wy + Math.sin(a) * l);
        g.stroke();
      }
    }
  }

  // moss patches
  for (let i = 0; i < 90; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 6 + rand() * 22;
    const v = 0.75 + rand() * 0.6;
    g.fillStyle = `rgba(${96 * v},${142 * v},${60 * v},0.28)`;
    for (const wx of [0, -size, size]) {
      for (const wy of [0, -size, size]) {
        g.beginPath();
        g.ellipse(x + wx, y + wy, r, r * 0.8, rand() * Math.PI, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  // small stones
  for (let i = 0; i < 140; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 1.5 + rand() * 4;
    const v = 130 + rand() * 80;
    g.fillStyle = `rgba(${v},${v * 0.95},${v * 0.88},0.6)`;
    g.beginPath();
    g.ellipse(x, y, r, r * 0.75, rand() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }

  return { map: toTexture(c), normalMap: heightToNormal(c, 1.4) };
}
