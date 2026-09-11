import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(`http://127.0.0.1:5188/${process.env.LOD_QUERY}`);
  await bootOrFail(page);
  await page.waitForTimeout(3000);
  const info = await page.evaluate((name) => ({
    camera: window.__probe().camera.map((v) => +v.toFixed(2)),
    target: window.__probe().target.map((v) => +v.toFixed(2)),
    charts: window.__lodChart(name),
  }), process.env.LOD_MESH ?? 'islandSand');
  console.log(JSON.stringify(info, null, 1).slice(0, 1600));
} finally { await browser.close(); }
