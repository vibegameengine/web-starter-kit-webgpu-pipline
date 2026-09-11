/* @important Design section 07's numeric criterion: the bake is compared against an independent
   diffuse path tracer, not against a sealed box alone. A box catches light that should not be there;
   it cannot catch an answer that is uniformly wrong - a bake three times too dark passes every test
   in check-leak-room. The reference shares no code with the renderer (scripts/lib/leakReference.mjs)
   and the run is ?env=0, so the only light is the analytic sun and the reference does not need the
   panorama. Headed, per the project rule. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { indirectAtPoint, leakRoomGeometry, LEAK_ROOM } from './lib/leakReference.mjs';

setTimeout(() => { console.error('gate: 6 minutes, abort'); process.exit(2); }, 360000);
const out = 'shots/leak-reference';
await mkdir(out, { recursive: true });
const gaps = (process.argv[2] ?? '0,20').split(',').map(Number);
const paths = Number(process.argv[3] ?? 8192);

const PROBES = [
  { name: 'inside floor centre', at: [0.15, 0.0005, 0.1], normal: [0, 1, 0] },
  { name: 'inside floor near gap', at: [0.85, 0.0005, 0], normal: [0, 1, 0] },
  { name: 'inside wall -X', at: [-0.9995, 1, 0], normal: [1, 0, 0] },
  { name: 'outside ground sunward', at: [2.4, 0.0005, 0], normal: [0, 1, 0] },
  { name: 'outside ground +Z', at: [0, 0.0005, 2.4], normal: [0, 1, 0] },
];

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

async function bakedAt(gap) {
  await page.goto(`http://127.0.0.1:5188/?scene=leak-room&cam=contact&gap=${gap}&leak=1&hud=0&inspector=0&still=1&aa=none&grain=0&exposure=1&env=0`);
  await page.waitForFunction(() => window.__leak?.stages().includes('resident') === true, null, { timeout: 150000 });
  await page.waitForFunction(() => document.querySelector('#loading-overlay')?.hidden === true, null, { timeout: 120000 }).catch(() => {});
  await writeFile(`${out}/gap-${gap}mm.png`, await page.screenshot());
  /* The scene sets a sun and setupSun then replaces both its direction and its intensity from the
     GUI's own light config, so the reference has to read what the renderer actually used. */
  const light = await page.evaluate(() => ({ position: window.__probe().sunPos, intensity: window.__probe().sunIntensity }));
  const probes = await page.evaluate((points) => points.map((probe) => {
    const report = window.__leak.atWorld(probe.at[0], probe.at[1], probe.at[2], 0.06);
    const value = report?.stages?.resident;
    return { name: probe.name, metres: report?.metres ?? null, luma: value ? 0.2126 * value[0] + 0.7152 * value[1] + 0.0722 * value[2] : null };
  }), PROBES);
  const length = Math.hypot(...light.position);
  return { probes, sun: light.position.map((v) => v / length), intensity: light.intensity };
}

const rows = [];
let sunUsed = null;
for (const gap of gaps) {
  const { probes: baked, sun, intensity } = await bakedAt(gap);
  sunUsed = { sun, intensity };
  const bodies = leakRoomGeometry({ gap: gap / 1000 });
  for (const [index, probe] of PROBES.entries()) {
    const options = { paths, sun, intensity, seed: 1 + index * 7919 };
    const reference = indirectAtPoint(bodies, probe.at, probe.normal, options);
    const half = indirectAtPoint(bodies, probe.at, probe.normal, { ...options, paths: Math.floor(paths / 2), seed: 104729 + index });
    rows.push({ gap, probe: probe.name, reference, noise: Math.abs(reference - half), ...baked[index] });
  }
}
await browser.close();

const sunlit = rows.filter((row) => row.probe.startsWith('outside') && row.luma !== null);
const scale = sunlit.length ? sunlit.reduce((sum, row) => sum + row.luma / row.reference, 0) / sunlit.length : null;
console.log(`sun ${sunUsed.intensity.toFixed(2)} from ${sunUsed.sun.map((v) => v.toFixed(3)).join(',')}, shell albedo ${LEAK_ROOM.shellAlbedo.toFixed(4)}, ground ${LEAK_ROOM.groundAlbedo.toFixed(4)}, ${paths} paths a probe`);
console.log(`baked / reference on the sunlit ground: ${scale === null ? 'no sample' : scale.toFixed(3)}`);
for (const row of rows) {
  const baked = row.luma === null ? 'none' : row.luma.toFixed(5);
  const ratio = row.luma === null || row.reference < 1e-9 ? '-' : (row.luma / row.reference).toFixed(3);
  console.log(`  gap ${String(row.gap).padStart(2)} mm  ${row.probe.padEnd(22)} baked ${baked}  reference ${row.reference.toFixed(5)} ±${row.noise.toFixed(5)}  ratio ${ratio}`);
}

const missing = rows.filter((row) => row.luma === null);
const outdoorAgrees = scale !== null && scale > 0.7 && scale < 1.4;
const interior = rows.filter((row) => row.probe.startsWith('inside') && row.luma !== null);
const withinReference = interior.every((row) => {
  const tolerance = Math.max(4 * row.noise, 0.15 * row.reference, 0.001 * (sunlit[0]?.reference ?? 1));
  return Math.abs(row.luma / (scale || 1) - row.reference) <= tolerance;
});
console.log(`errors ${errors.length}${errors.length ? ': ' + errors.slice(0, 2).join(' | ').slice(0, 300) : ''}`);
console.log(`every probe resolved: ${missing.length === 0 ? 'PASS' : `FAIL (${missing.map((row) => row.probe).join(', ')})`}`);
console.log(`outdoor scale within 0.7..1.4 of the reference: ${outdoorAgrees ? 'PASS' : 'FAIL'}`);
console.log(`interior matches the reference: ${withinReference ? 'PASS' : 'FAIL'}`);
process.exit(missing.length === 0 && outdoorAgrees && withinReference && errors.length === 0 ? 0 : 1);
