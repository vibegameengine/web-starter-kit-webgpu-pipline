// Prints RGB at named landmarks in two captures, with the per-channel ratio.
//
//   node scripts/pixels.mjs shots/cmp-a.png shots/cmp-b.png
//
// compare.mjs answers "how different". This answers "different where, and in which
// channel" — which is what separates a colour bug from an energy deficit. It is how
// the lightmap bake's washed-out walls were traced to every material sharing one
// emissive node, rather than to the bake itself.
//
// Both inputs must be the same size. compare.mjs writes 1280x800 and `npm run shot`
// defaults to 1600x900; mixing them silently probes different surfaces and produces
// confident nonsense.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const a = PNG.sync.read(readFileSync(process.argv[2]));
const b = PNG.sync.read(readFileSync(process.argv[3]));

if (a.width !== b.width || a.height !== b.height) {
  console.error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  process.exit(2);
}

// Cornell landmarks at 1280x800, chosen to separate the failure modes: flat surfaces
// fed by bounce, surfaces fed by direct sun, and the corners/contacts where a baked
// lightmap and a surfel resolve legitimately disagree.
const points = [
  ['left wall (shadow)', 250, 300],
  ['left wall (sunlit)', 250, 620],
  ['green wall', 1030, 300],
  ['back wall', 640, 350],
  ['floor centre', 640, 660],
  ['ceiling panel', 400, 150],
  ['tall box left', 530, 470],
  ['short box top', 760, 500],
  ['corner wall/floor L', 300, 645],
  ['corner back/floor', 700, 600],
  ['contact box base', 560, 578],
  ['corner ceil/back', 640, 258],
  ['corner wall/back R', 940, 350],
];

const px = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

console.log('point                   A                B                B/A');
for (const [name, x, y] of points) {
  const A = px(a, x, y);
  const B = px(b, x, y);
  const ratio = A.map((v, k) => (v ? (B[k] / v).toFixed(2) : '--')).join('/');
  console.log(
    `${name.padEnd(23)} ${A.join(',').padEnd(16)} ${B.join(',').padEnd(16)} ${ratio}`,
  );
}
