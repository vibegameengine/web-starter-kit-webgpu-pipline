import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';
import { mkdir } from 'node:fs/promises';
const out = 'shots/bench';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
try {
  for (const [tag, query] of [['resident', 'lod=0'], ['lod', 'lod=1']]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.goto(`http://127.0.0.1:5188/?scene=corridor&cam=bench&${query}&still=1&freezeAt=0`);
    await bootOrFail(page);
    await page.addStyleTag({ content: '.lil-gui, #hud { display: none !important; }' });
    await page.evaluate(() => { window.__audit.hideOverlay(); window.__audit.sun(-116.5, 53.2, 12.13); window.__camera(1.6, 1.5, 0.2, 0.0, 0.45, -1.6); });
    await page.waitForTimeout(3500);
    await page.screenshot({ path: `${out}/${tag}.png` });
    await page.close();
  }
} finally { await browser.close(); }
console.log('captured');
