import { chromium } from 'playwright';
// Probes the solver's conservative state near the open −x face. Optional args:
// --amp <m> sets the swell amplitude first; --dir <deg> the swell direction.
const args = process.argv.slice(2);
const amp = args.includes('--amp') ? Number(args[args.indexOf('--amp') + 1]) : null;
const dir = args.includes('--dir') ? Number(args[args.indexOf('--dir') + 1]) : null;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('pageerror', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:5188/?scene=beach&hud=0&mode=surfel&bake=0');
await page.waitForFunction(() => !!window.__water && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
if (amp !== null || dir !== null) {
  await page.evaluate(({ amp, dir }) => { const c = window.__water.controls(); if (amp !== null) c.swellAmplitude = amp; if (dir !== null) c.swellDirection = dir; c.apply(); }, { amp, dir });
  await page.waitForTimeout(4000);
}
for (const wait of [500, 400, 400, 400, 400, 400, 400, 400]) {
  await page.waitForTimeout(wait);
  const p = await page.evaluate(() => window.__water.simProbe());
  console.log(JSON.stringify({ face: p.faceW[2], row: p.rowW.slice(0, 9), huMax: p.huMax, huMin: p.huMin, wMin: p.wMin }));
}
await browser.close();
