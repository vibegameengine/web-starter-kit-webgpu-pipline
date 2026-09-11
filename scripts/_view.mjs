import { chromium } from 'playwright';
import { watchPipelineError } from './_harness.mjs';
import { mkdir } from 'node:fs/promises';
await mkdir('shots/view', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const failed = watchPipelineError(page);
  failed.catch(() => {});
  await page.goto(`http://127.0.0.1:5188/${process.env.Q}`);
  await Promise.race([failed, page.waitForFunction(() => window.__audit && !document.querySelector('#loading-overlay')?.offsetParent, null, { timeout: 300000 })]);
  await page.addStyleTag({ content: '.lil-gui, #hud { display: none !important; }' });
  await page.evaluate(() => window.__audit.hideOverlay());
  for (const shot of JSON.parse(process.env.SHOTS)) {
    await page.evaluate((c) => window.__camera(c[0], c[1], c[2], c[3], c[4], c[5]), shot.cam);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `shots/view/${shot.tag}.png`, timeout: 120000, animations: 'disabled' });
  }
  console.log('captured');
} finally { await browser.close(); }
