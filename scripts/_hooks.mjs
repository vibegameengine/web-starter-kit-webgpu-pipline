import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
p.on('pageerror', e => console.log('pageerror', String(e).slice(0, 200)));
await p.goto('http://127.0.0.1:5188/?scene=beach&hud=0&mode=surfel&bake=0');
await p.waitForFunction(() => document.querySelector('#loading-overlay')?.hidden, null, { timeout: 240000 });
console.log(await p.evaluate(() => ({
  water: typeof window.__lagoon, waterKeys: window.__lagoon ? Object.keys(window.__lagoon) : null,
  ball: typeof window.__ball, ballKeys: window.__ball ? Object.keys(window.__ball) : null,
})));
await b.close();
