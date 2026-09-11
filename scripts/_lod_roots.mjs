import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(`http://127.0.0.1:5188/${process.env.LOD_QUERY ?? '?scene=corridor&cam=bench&lod=1&lodAtlas=128'}`);
  await bootOrFail(page);
  await page.waitForTimeout(2500);
  const roots = await page.evaluate(() => window.__lodPixels(0, 0, 16, 2));
  const nonZero = roots.filter((v, i) => i % 4 !== 3 && v > 0.0001).length;
  console.log(JSON.stringify({ nonZeroChannels: nonZero, first: roots.slice(0, 16).map(v => +v.toFixed(4)) }));
} finally { await browser.close(); }
