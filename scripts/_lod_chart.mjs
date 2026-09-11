import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(`http://127.0.0.1:5188/${process.env.LOD_QUERY ?? '?scene=corridor&cam=bench&lod=1&lodAtlas=128'}`);
  await bootOrFail(page);
  await page.waitForTimeout(2000);
  const bench = await page.evaluate(() => window.__lodChart('bench'));
  const floor = await page.evaluate(() => window.__lodChart('floor'));
  console.log(JSON.stringify({ bench, floor: floor?.slice(0, 3) }, null, 1));
} finally { await browser.close(); }
