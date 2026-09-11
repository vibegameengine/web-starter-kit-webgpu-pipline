import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:5188/${process.env.LOD_QUERY}`);
  await bootOrFail(page);
  await page.waitForTimeout(5000);
  console.log(JSON.stringify({ lod: await page.evaluate(() => window.__lod()), errors: errors.slice(0, 3) }, null, 1));
} finally { await browser.close(); }
