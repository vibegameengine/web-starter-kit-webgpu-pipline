import { chromium } from 'playwright';
// Measures the swash excursion: along the row z = --z (default -1.5 m), the x of the
// wettest edge (first cell from the sea with depth > 1 mm) every 150 ms for --secs
// seconds, plus the bore depth near the shoreline. Compares with Shen–Meyer:
// R = u0² / (2 g sinβ), u0 = 2·√(g·h_bore).
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const z = Number(arg('--z', '-1.5'));
const secs = Number(arg('--secs', '8'));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('pageerror', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:5188/?scene=beach&hud=0&mode=surfel&bake=0');
await page.waitForFunction(() => !!window.__water && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 240000 });
const samples = [];
const t0 = Date.now();
while (Date.now() - t0 < secs * 1000) {
  const r = await page.evaluate(async (z) => {
    const s = await window.__water.simRow(z);
    return s;
  }, z);
  samples.push(r);
  await page.waitForTimeout(150);
}
let xMin = Infinity, xMax = -Infinity, hbMax = 0;
for (const s of samples) { xMin = Math.min(xMin, s.edgeX); xMax = Math.max(xMax, s.edgeX); hbMax = Math.max(hbMax, s.hNearShore); }
console.log('samples', samples.length, 'edge x range', xMin.toFixed(2), '..', xMax.toFixed(2), 'excursion', (xMax - xMin).toFixed(2), 'm; slope', samples[0].slope.toFixed(3), '; max depth 30 cm seaward of the edge', hbMax.toFixed(3));
const u0 = 2 * Math.sqrt(9.81 * hbMax);
console.log('Shen–Meyer frictionless: u0', u0.toFixed(2), 'm/s, R', (u0 * u0 / (2 * 9.81 * samples[0].slope)).toFixed(2), 'm along the slope');
console.log(samples.map(s => s.edgeX.toFixed(2)).join(' '));
await browser.close();
