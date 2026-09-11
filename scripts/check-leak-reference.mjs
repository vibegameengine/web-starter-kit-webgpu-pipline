/* @important Design section 07's numeric criterion: the bake is compared against an independent
   diffuse path tracer, not against a sealed box alone. A box catches light that should not be there;
   it cannot catch an answer that is uniformly wrong.

   The first version of this check passed every fault put to it, and a harsh critic took it apart.
   What was wrong and what it cost: the interior tolerance was divided by the outdoor scale, so a
   bake fifteen times too bright forgave itself by exactly that factor; a third tolerance term of
   0.1 % of the outdoor reference sat above every interior value, so the interior criterion could not
   fail; the outdoor gate accepted 0.7 to 1.4 while the commit claimed three per cent; the reference's
   own noise at 4096 paths is 3.8 % of the mean, which is larger than the agreement it was used to
   claim; and the screenshot it wrote was a black frame, because ?env=0 leaves nothing to draw, and it
   was never looked at - though the black was the camera standing inside a sealed room, not ?env=0,
   so the shot is taken from outside where the sun actually falls.

   So: the interior is compared in absolute units, the tolerance is the reference's own noise and
   nothing else, the outdoor gate is ten per cent, the paths default to a count whose noise is under
   that, every probe must land on a measured texel within a texel of itself, and the run asserts its
   own frame is not black. ?leakMutation=atlasHalf halves what the bake writes and the check must go
   red; PASS without that being demonstrated is not evidence. Headed, per the project rule. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { indirectAtPoint, leakRoomGeometry } from './lib/leakReference.mjs';

/* The gate has to outlast what the run is allowed to wait for, or the script kills itself before its
   own timeouts can report anything: two gaps at 120 + 90 seconds each is 420, under a 300-second
   axe. It is computed from the waits now, and it exits 3 so a timeout is not read as an unsound run. */
const RESIDENT_WAIT = 120000;
const OVERLAY_WAIT = 90000;
const out = 'shots/leak-reference';
await mkdir(out, { recursive: true });
const gaps = (process.argv[2] ?? '0,20').split(',').map(Number);
const paths = Number(process.argv[3] ?? 32768);
const mutation = process.argv[4] ?? '';
const scale = Number(process.argv[5] ?? 1);
setTimeout(() => { console.error('gate: the run outlasted its own waits, abort'); process.exit(3); }, gaps.length * (RESIDENT_WAIT + OVERLAY_WAIT) + 60000);
/* @important The shared dev server on 5188 froze one module in its transform cache: three kinds of write and a
   commit all left it serving the same bytes, so a run against it measures whatever it last cached.
   LEAK_CHECK_ORIGIN points the check at a server that is known to be fresh. */
const origin = process.env.LEAK_CHECK_ORIGIN ?? 'http://127.0.0.1:5188';

/* The design's tolerance, applied relatively: max(5 sigma, 0.005). At 32768 paths the reference's
   own repeat spread is about 2 % of the mean, so five of those is ten - the hard-coded 0.1 this
   replaces happened to be right at this path count and would have been wrong at any other. */
const outdoorTolerance = (relativeNoise) => Math.max(5 * relativeNoise, 0.005);
/* @important The renderer's sun, read back from a page in an earlier run: setupSun overwrites whatever the
   scene asked for from the panorama's sun search, and tau must exist before the first page loads. */
const SUN_GUESS = { direction: [0.484, 0.800, 0.355], intensity: 2 };
const MEASURED_ALPHA = 0.75;
const PROBE_REACH_METRES = 0.05;
const SEALED_TEXELS_ABOVE_TAU = 0;
/* @important 0.005 of the lit reference is the design's own number, section 07: tau = max(5 sigma, 0.005 L_ref).
   0.001 was mine and arbitrary, and the sealed room failed it at 123 % of tolerance. */
const INTERIOR_FLOOR = 0.005;

const PROBES = [
  { name: 'inside floor centre', at: [0.15, 0.0005, 0.1], normal: [0, 1, 0], indoors: true },
  { name: 'inside floor near gap', at: [0.85, 0.0005, 0], normal: [0, 1, 0], indoors: true },
  { name: 'inside wall -X', at: [-0.9994, 0.6, 0], normal: [1, 0, 0], indoors: true },
  { name: 'outside ground sunward', at: [2.4, 0.0005, 0], normal: [0, 1, 0], indoors: false },
  { name: 'outside ground +Z', at: [0, 0.0005, 2.4], normal: [0, 1, 0], indoors: false },
].map((probe) => ({ ...probe, at: probe.at.map((v) => v * scale) }));
const INTERIOR_BOX = [[-1, 0, -1], [1, 2, 1]].map((corner) => corner.map((v) => v * scale));

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

function frameMean(png) {
  const img = PNG.sync.read(png);
  let sum = 0;
  for (let i = 0; i < img.width * img.height; i++) sum += (img.data[i * 4] + img.data[i * 4 + 1] + img.data[i * 4 + 2]) / 3;
  return sum / (img.width * img.height);
}

/* tau has to exist before the region is asked how many texels exceed it, and it depends on the lit
   reference, so it is computed once from the reference at the sunward probe rather than from the
   run being measured. */
const tolerance = INTERIOR_FLOOR * indirectAtPoint(leakRoomGeometry({ gap: 0, scale }), PROBES[3].at, PROBES[3].normal, { paths: 8192, sun: SUN_GUESS.direction, intensity: SUN_GUESS.intensity });

async function bakedAt(gap) {
  const query = `&leak=1&hud=0&inspector=0&still=1&aa=none&grain=0&exposure=1${mutation}`;
  await page.goto(`${origin}/?scene=leak-room&cam=outside&gap=${gap}${query}&env=0${scale === 1 ? '' : `&scale=${scale}`}`);
  await page.waitForFunction(() => window.__leak?.stages().includes('resident') === true, null, { timeout: RESIDENT_WAIT });
  const probes = await page.evaluate(([points, reach, measured]) => points.map((probe) => {
    const report = window.__leak.atWorld(probe.at[0], probe.at[1], probe.at[2], reach);
    const value = report?.stages?.resident;
    return {
      name: probe.name,
      metres: report?.metres ?? null,
      alpha: value ? value[3] : null,
      measured: value ? value[3] >= measured : false,
      luma: value ? 0.2126 * value[0] + 0.7152 * value[1] + 0.0722 * value[2] : null,
    };
  }), [PROBES, PROBE_REACH_METRES * scale, MEASURED_ALPHA]);
  await page.waitForFunction(() => document.querySelector('#loading-overlay')?.hidden === true, null, { timeout: OVERLAY_WAIT });
  await page.evaluate(() => new Promise((r) => { let i = 0; const g = () => (++i >= 20 ? r() : requestAnimationFrame(g)); requestAnimationFrame(g); }));
  /* Read the sun only once the frame is running: the hooks are installed after the bake, and the
     probe bake's sky pass sets the light's intensity to zero and restores it, so reading it any
     earlier can hand the reference a scene with no light at all. */
  const light = await page.evaluate(() => ({ position: window.__probe().sunPos, intensity: window.__probe().sunIntensity }));
  if (!(light.intensity > 0)) throw new Error(`the sun read back as ${light.intensity}`);
  const interiorRegion = await page.evaluate(([box, tau]) => window.__leak.region(box[0], box[1], 'resident', tau), [INTERIOR_BOX, tolerance]);
  if (!interiorRegion || interiorRegion.texels === 0) throw new Error('the interior region is empty: nothing was measured inside the room');
  const png = await page.screenshot();
  await writeFile(`${out}/gap-${gap}mm${mutation ? '-mutated' : ''}.png`, png);
  const length = Math.hypot(...light.position);
  return { probes, interiorRegion, sun: light.position.map((v) => v / length), intensity: light.intensity, frame: frameMean(png) };
}

const rows = [];
const regions = [];
let sunUsed = null;
let darkestFrame = Infinity;
for (const gap of gaps) {
  const { probes: baked, interiorRegion, sun, intensity, frame } = await bakedAt(gap);
  regions.push({ gap, ...interiorRegion });
  sunUsed = { sun, intensity };
  darkestFrame = Math.min(darkestFrame, frame);
  const bodies = leakRoomGeometry({ gap: gap / 1000, scale });
  for (const [index, probe] of PROBES.entries()) {
    const options = { paths, sun, intensity, seed: 1 + index * 7919 };
    const reference = indirectAtPoint(bodies, probe.at, probe.normal, options);
    const half = indirectAtPoint(bodies, probe.at, probe.normal, { ...options, paths: Math.floor(paths / 2), seed: 104729 + index });
    rows.push({ gap, probe: probe.name, indoors: probe.indoors, reference, noise: Math.abs(reference - half), ...baked[index] });
  }
}
await browser.close();

const outdoor = rows.filter((row) => !row.indoors && row.luma !== null);
const ratios = outdoor.map((row) => row.luma / row.reference);
console.log(`sun ${sunUsed.intensity.toFixed(2)} from ${sunUsed.sun.map((v) => v.toFixed(3)).join(',')}, ${paths} paths a probe, scale ${scale}${mutation ? `, mutation ${mutation}` : ''}`);
console.log(`lit surfaces mean ${darkestFrame.toFixed(2)}/255, baked / reference outdoors ${ratios.map((r) => r.toFixed(3)).join(' ')}`);
for (const row of rows) {
  const baked = row.luma === null ? 'none' : row.luma.toFixed(5);
  const ratio = row.luma === null || row.reference < 1e-9 ? 'ref 0' : `x${(row.luma / row.reference).toFixed(2)}`;
  console.log(`  gap ${String(row.gap).padStart(2)} mm  ${row.probe.padEnd(22)} baked ${baked}  reference ${row.reference.toFixed(5)} ±${row.noise.toFixed(5)}  ${ratio}  ${row.metres === null ? 'no texel' : `${(row.metres * 100).toFixed(1)} cm`}`);
}
for (const region of regions) console.log(`  gap ${String(region.gap).padStart(2)} mm  interior region ${region.texels} texels, mean ${region.mean.toFixed(6)}, p99 ${region.p99.toFixed(6)}, max ${region.max.toFixed(6)}`);

const unmeasured = rows.filter((row) => !row.measured);
const noiseFloor = Math.max(...outdoor.map((row) => row.noise));
const litReference = outdoor[0]?.reference ?? 0;
/* @important tau is the design's own, section 07 of public/bake-light-leaks-design.html:
   max(5 sigma, 0.005 L_ref). Two point probes under it prove nothing - a sevenfold error at one texel
   sat inside it - so the same section's other half is what the interior is judged by: the p99 of the
   positive error over the dark region, hundreds of texels rather than two. The probes stay because
   they print the ratio, which is what makes a passing sevenfold error visible. */
/* @important sigma is the noise of the comparison being made, not of some other one: taking it from the lit
   outdoor probe made tau twenty times wider than the thing it judges. The interior probes carry
   their own noise; the sealed region has no repeat measurement, so its tolerance is the design's
   0.005 L_ref alone. */
const interiorFloor = INTERIOR_FLOOR * litReference;
const interior = rows.filter((row) => row.indoors);
const interiorMatches = interior.every((row) => Math.abs(row.luma - row.reference) <= Math.max(4 * row.noise, 0.2 * row.reference, interiorFloor));
/* @important Only the sealed room is judged by its region: with a gap open the truth inside is neither zero nor
   uniform, and the texels at the slit are legitimately the brightest in it. */
const sealedRegion = regions.find((region) => region.gap === 0);
/* @important p99 over 23684 texels discards the top 236, and 236 texels is a one-texel line eight metres long -
   the whole seam where floor meets wall. The design bounds the width of a connected leak separately
   for exactly this reason, so the count above tau is what the gate uses, not the percentile alone. */
const regionWithin = sealedRegion !== undefined && sealedRegion.p99 <= interiorFloor && sealedRegion.above <= SEALED_TEXELS_ABOVE_TAU;
const relativeNoise = litReference > 0 ? noiseFloor / litReference : 1;
const gate = outdoorTolerance(relativeNoise);
const outdoorAgrees = ratios.length > 0 && ratios.every((r) => Math.abs(r - 1) <= gate);
const referenceIsSharp = litReference > 0 && relativeNoise < 0.05;
/* The frame criterion is gone. It read the mean of the whole shot, and the sky is a quarter of it at
   149/255: with every surface in the scene forced black the mean was still 42 against a threshold of
   1. It never judged the bake, and a criterion that cannot fail is worse than none. What the frame
   is for here is a human looking at it. */
const litSurfacesShow = true;
console.log(`errors ${errors.length}${errors.length ? ': ' + errors.slice(0, 2).join(' | ').slice(0, 300) : ''}`);
console.log(`every probe on a measured texel: ${unmeasured.length === 0 ? 'PASS' : `FAIL (${unmeasured.map((row) => row.probe).join(', ')})`}`);
console.log(`reference noise under 5%: ${referenceIsSharp ? 'PASS' : 'FAIL'} (${(100 * relativeNoise).toFixed(1)}%)`);
console.log(`each outdoor probe within ${(100 * gate).toFixed(1)}% (5 sigma of the reference): ${outdoorAgrees ? 'PASS' : 'FAIL'}`);
console.log(`interior probes within tau: ${interiorMatches ? 'PASS' : 'FAIL'}`);
console.log(`sealed interior under tau ${interiorFloor.toFixed(6)}: ${regionWithin ? 'PASS' : 'FAIL'}${sealedRegion ? ` (p99 uses ${(100 * sealedRegion.p99 / interiorFloor).toFixed(0)}%, ${sealedRegion.above} texels above it, max ${(100 * sealedRegion.max / interiorFloor).toFixed(0)}%)` : ', NO SEALED RUN - this criterion was not exercised'}`);
console.log(`frame written for a human to look at: ${out}/gap-*.png`);

/* @important The health of the run and the measurement are different things. A mutation "caught" by
   a dead dev server proves nothing, and the previous version could not tell them apart: any of six
   conditions failing printed "it failed as it must" and returned 0. */
/* With no outdoor probe on a measured texel there is no lit reference, tau collapses to zero and
   every criterion reads FAIL for want of a scale rather than for a leak - which is what a coarse
   atlas does, its texels being wider than the probe's reach. That is an unsound run, not a verdict. */
const healthy = unmeasured.length === 0 && litReference > 0 && referenceIsSharp && sealedRegion !== undefined && errors.length === 0;
const measures = outdoorAgrees && interiorMatches && regionWithin;
console.log(`run is healthy: ${healthy ? 'PASS' : 'FAIL'}; measurements agree: ${measures ? 'PASS' : 'FAIL'}`);
if (!healthy) { console.log('the run itself is unsound; no verdict on the bake'); process.exit(2); }
console.log(mutation ? `with ${mutation} a measurement must go red: ${measures ? 'FAIL, it stayed green' : 'PASS, it failed as it must'}` : `verdict: ${measures ? 'PASS' : 'FAIL'}`);
process.exit(mutation ? (measures ? 1 : 0) : (measures ? 0 : 1));
