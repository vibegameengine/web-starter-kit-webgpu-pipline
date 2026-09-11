import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.goto(`http://127.0.0.1:5188/${process.env.LOD_QUERY ?? '?scene=corridor&cam=bench'}`);
  await bootOrFail(page);
  const charts = await page.evaluate((name) => window.__chartLight(name), process.env.LOD_MESH ?? 'bench');
  console.log(JSON.stringify(charts));
} finally { await browser.close(); }
