import { chromium } from 'playwright';
import { watchPipelineError } from './_harness.mjs';
import { mkdir } from 'node:fs/promises';
await mkdir('shots/bench', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const lines = [];
  page.on('console', (m) => { const t = m.text(); if (/\[lightmap\]|\[lod\]/.test(t) && !/Baking/.test(t)) lines.push(t.slice(0, 160)); });
  const failed = watchPipelineError(page);
  failed.catch(() => {});
  await page.goto(`http://127.0.0.1:5188/${process.env.Q ?? '?scene=corridor&cam=bench&still=1&freezeAt=0'}`);
  await Promise.race([failed, page.waitForFunction(() => window.__audit && !document.querySelector('#loading-overlay')?.offsetParent, null, { timeout: 300000 })]);
  await page.addStyleTag({ content: '.lil-gui, #hud { display: none !important; }' });
  await page.evaluate(() => { window.__audit.hideOverlay(); window.__audit.sun(-116.5, 53.2, 12.13); });
  if (!process.env.KEEPCAM) await page.evaluate(() => window.__camera(1.4, 1.1, -0.6, 0.0, 0.42, -1.7));
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `shots/bench/${process.env.TAG ?? 'now'}.png`, timeout: 120000, animations: 'disabled' });
  console.log(lines.join('\n'));
} finally { await browser.close(); }
