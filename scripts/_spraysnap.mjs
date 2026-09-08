import { chromium } from 'playwright';
// Screenshot at the moment of a splash: waits until the spray pool has more than
// `--min` living droplets (default 300), then captures. `--cam rocks`, `--out path`.
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const cam = arg('--cam', 'rocks');
const out = arg('--out', 'shots/beach/spray-snap.png');
const min = Number(arg('--min', '300'));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', e => console.log('pageerror', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&mode=surfel&bake=0&cam=${cam}&sprayTest=${arg('--test', '0')}`);
await page.waitForFunction(() => !!window.__water && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 240000 });
await page.waitForTimeout(3000);
let best = 0;
for (let i = 0; i < 120; i++) {
  const { alive } = await page.evaluate(() => window.__water.sprayStats());
  best = Math.max(best, alive);
  if (alive >= min) { console.log('alive', alive, 'at poll', i); break; }
  await page.waitForTimeout(150);
}
await page.screenshot({ path: out });
console.log('saved', out, 'best alive seen', best);
await browser.close();
