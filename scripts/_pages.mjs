import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.goto(`http://127.0.0.1:5188/${process.env.Q}`);
  await bootOrFail(page, 300000);
  console.log(JSON.stringify(await page.evaluate(() => window.__pages()), null, 1));
} finally { await browser.close(); }
