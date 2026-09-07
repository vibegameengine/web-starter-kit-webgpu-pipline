import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://127.0.0.1:5188/?scene=beach&hud=0&mode=surfel&bake=0');
await page.waitForFunction(() => !!window.__water && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 120000 });
await page.waitForTimeout(3000);
console.log(JSON.stringify(await page.evaluate(() => window.__water.foamDebug())));
console.log(await page.evaluate(async () => { try { return JSON.stringify(await window.__water.foamStats()); } catch (e) { return 'ERR ' + (e.stack || e); } }));
await browser.close();
