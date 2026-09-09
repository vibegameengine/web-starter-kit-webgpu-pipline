import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('pageerror', String(e).slice(0, 600)));
page.on('console', m => { const t = m.text(); if (/error|Error|fail|invalid/i.test(t)) console.log('console:', t.slice(0, 400)); });
await page.goto('http://127.0.0.1:5188/?scene=beach&hud=0&mode=surfel&bake=0');
await page.waitForFunction(() => !!window.__ball && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 240000 });
for (let i = 0; i < 8; i++) {
  await page.evaluate(() => new Promise(r => { const t = performance.now(); const tick = () => (performance.now() - t > 600 ? r(0) : requestAnimationFrame(tick)); requestAnimationFrame(tick); }));
  console.log(JSON.stringify(await page.evaluate(() => ({ pose: window.__ball.pose(), water: window.__ball.reading() }))));
}
await browser.close();
