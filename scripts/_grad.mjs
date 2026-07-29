// Contact gradient: Rec.709 luma at N pixels from the red-wall/floor junction.
//
// The junction is located by projecting the world-space edge with the *same* camera
// the capture used, not by hunting for it in the image. An edge detector would find a
// different line once a contact term darkens one side of it, which would make the
// measurement move with the thing being measured.
//
// Cornell geometry (content.ts, group scaled 4x and offset y=-0.5): the red wall's
// inner face is at x = -4.0, the floor's top face at y = -0.5. The junction is the
// line (x=-4, y=-0.5, z).
//
// Usage: node scripts/_grad.mjs <png> [px py pz tx ty tz] [--z 0] [--offsets 0,5,15,...]
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const args = process.argv.slice(2);
const file = args[0];
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const pose = args.slice(1).filter((a) => !a.startsWith('--') && !Number.isNaN(Number(a)));
const [ex, ey, ez, tx, ty, tz] =
  pose.length >= 6 ? pose.slice(0, 6).map(Number) : [-0.9, 0.75, 2.6, -3.7, -0.4, -0.2];
const zJunction = Number(flag('z', '0'));
const offsets = flag('offsets', '0,5,15,40,100,180').split(',').map(Number);
// Half-width of the strip averaged along the junction line. Wide enough to bury probe
// noise, narrow enough that the strip stays on one plane.
const halfSpan = Number(flag('span', '30'));
const FOV_DEG = 60;

const img = PNG.sync.read(readFileSync(file));
const W = img.width;
const H = img.height;

// --- camera ------------------------------------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

const eye = [ex, ey, ez];
// three.js looks down -Z, so the view basis is (right, up, backward).
const zAxis = norm(sub(eye, [tx, ty, tz]));
const xAxis = norm(cross([0, 1, 0], zAxis));
const yAxis = cross(zAxis, xAxis);

const f = 1 / Math.tan(((FOV_DEG * Math.PI) / 180) / 2);
const aspect = W / H;

function project(p) {
  const v = sub(p, eye);
  const vx = dot(v, xAxis);
  const vy = dot(v, yAxis);
  const vz = dot(v, zAxis); // positive = behind the camera
  if (vz >= -1e-6) return null;
  const ndcX = (f / aspect) * vx / -vz;
  const ndcY = f * vy / -vz;
  return [(ndcX * 0.5 + 0.5) * W, (1 - (ndcY * 0.5 + 0.5)) * H];
}

const luma = (x, y) => {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return null;
  const i = (yi * W + xi) * 4;
  return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
};

// The junction is a line, not a point, and the indirect term on this floor is mottled
// at the scale of a surfel — tens of pixels. Averaging one screen-space strip at one z
// measures the mottling, not the contact: the first attempt at this returned 69.5, 71.6,
// 71.1, 64.4, 71.1, 57.9 for a monotone quantity. So every offset is averaged along the
// whole *visible* length of the junction instead, each z contributing its own local
// "away" direction, which is several hundred taps per row rather than sixty.
//
// Visibility is decided by screen bounds with a margin. Where the tall box hides the far
// end of the junction, that end simply projects outside the kept window.
const zLo = Number(flag('zlo', '-1.6'));
const zHi = Number(flag('zhi', '2.6'));
const zStep = Number(flag('zstep', '0.02'));
const marginX = Number(flag('marginX', '24'));
const rows = [];
for (let z = zLo; z <= zHi + 1e-9; z += zStep) {
  const p0 = project([-4.0, -0.5, z]);
  const p1 = project([-3.0, -0.5, z]);
  if (!p0 || !p1) continue;
  if (p0[0] < marginX || p0[0] > W - marginX) continue;
  if (p0[1] < marginX || p0[1] > H - marginX) continue;
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) continue;
  rows.push({ z, p0, away: [dx / len, dy / len], worldPerPx: 1 / len });
}

if (rows.length === 0) {
  console.error('no visible junction at this pose — check the numbers');
  process.exit(2);
}

const mid = rows[Math.floor(rows.length / 2)];
console.log(
  `${file}  ${rows.length} junction rows, z ${rows[0].z.toFixed(2)}..${rows[
    rows.length - 1
  ].z.toFixed(2)}  ` +
    `mid junction=(${mid.p0[0].toFixed(0)},${mid.p0[1].toFixed(0)})px  ` +
    `1px = ${(mid.worldPerPx * 100).toFixed(2)}cm`,
);
// Each row samples the same *world* distance from the wall, not the same pixel offset.
// A pixel is 0.75cm at the middle of this junction and over 2cm at its far end, so a
// fixed pixel offset would walk different rows onto different geometry — at the far end,
// onto the tall box. The requested offsets are therefore converted once, at the middle
// row, and every row then samples that distance. The px column is exact where the table
// says it is and the taps all sit on floor.
console.log('px from junction |   luma |   taps | world cm from wall');
for (const d of offsets) {
  const worldDist = d * mid.worldPerPx;
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    const p = project([-4.0 + worldDist, -0.5, r.z]);
    if (!p) continue;
    const v = luma(p[0], p[1]);
    if (v !== null) {
      sum += v;
      n++;
    }
  }
  console.log(
    `${String(d).padStart(16)} | ${n ? (sum / n).toFixed(1).padStart(6) : '   n/a'} | ${String(
      n,
    ).padStart(6)} | ${(worldDist * 100).toFixed(1)}`,
  );
}
void halfSpan;
void zJunction;
