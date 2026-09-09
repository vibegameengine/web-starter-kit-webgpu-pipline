import { chromium } from 'playwright';
// A strip of consecutive frames from one camera: the only way to judge water, which
// is a motion, from a still tool. `--n 6 --gap 220 --cam eye --query "&wind=12"`.
const args = process.argv.slice(2); const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const n = Number(arg('--n', '6')); const gap = Number(arg('--gap', '220'));
const cam = arg('--cam', 'eye'); const extra = arg('--query', ''); const out = arg('--out', 'shots/beach/burst');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', e => console.log('pageerror', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&mode=surfel&bake=0&cam=${cam}${extra}`);
await page.waitForFunction(() => document.querySelector('#loading-overlay')?.hidden, null, { timeout: 240000 });
const spin = (ms) => page.evaluate((ms) => new Promise(r => { const t = performance.now(); const tick = () => (performance.now() - t > ms ? r(0) : requestAnimationFrame(tick)); requestAnimationFrame(tick); }), ms);
await spin(3000);
for (let i = 0; i < n; i++) {
  await spin(gap);
  await page.screenshot({ path: `${out}-${i}.png` });
}
console.log('saved', n, 'frames to', out + '-*.png');
await browser.close();
