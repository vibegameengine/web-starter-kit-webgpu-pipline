import { chromium } from 'playwright';
// Cell-to-cell alternation of the solver's depth along a row: an odd-even (checker)
// oscillation at the wet/dry front prints as a run of sign flips in d[i+1]-d[i].
const z = Number(process.argv[2] ?? '1.5');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('pageerror', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:5188/?scene=beach&hud=0&mode=surfel&bake=0');
await page.waitForFunction(() => !!window.__lagoon && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 240000 });
const spin = (ms) => page.evaluate((ms) => new Promise(r => { const t = performance.now(); const tick = () => (performance.now() - t > ms ? r(0) : requestAnimationFrame(tick)); requestAnimationFrame(tick); }), ms);
await spin(4000);
for (let k = 0; k < 3; k++) {
  await spin(500);
  const row = await page.evaluate((z) => (window.__lagoon.depthRow ? window.__lagoon.depthRow(z) : window.__lagoon.simRow(z)), z);
  const d = row.depth;
  let edge = 0;
  for (let i = 2; i < d.length - 3; i++) if (d[i] > 0.001) edge = i;
  const from = Math.max(0, edge - 24);
  const seg = Array.from(d.slice(from, edge + 2));
  let flips = 0;
  for (let i = 1; i < seg.length - 1; i++) {
    const a = seg[i] - seg[i - 1], b = seg[i + 1] - seg[i];
    if (a * b < 0) flips++;
  }
  console.log('edge cell', edge, 'flips in last 26 cells:', flips, 'of', seg.length - 2);
  console.log('  d:', seg.map(v => (v * 1000).toFixed(1)).join(' '), '(mm)');
}
await browser.close();
