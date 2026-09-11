import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';
import { mkdir } from 'node:fs/promises';
const out = 'shots/bench';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const lines = [];
  page.on('console', (m) => { const t = m.text(); if (/lightmap|probes/i.test(t)) lines.push(t); });
  await page.goto(`http://127.0.0.1:5188/?scene=corridor&cam=bench&still=1&freezeAt=0`);
  await bootOrFail(page);
  await page.addStyleTag({ content: '.lil-gui, #hud { display: none !important; }' });
  await page.evaluate(() => { window.__audit.hideOverlay(); window.__audit.sun(-116.5, 53.2, 12.13); window.__camera(1.4, 1.1, -0.6, 0.0, 0.42, -1.7); });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${out}/${process.env.TAG ?? 'now'}.png` });
  const charts = await page.evaluate(() => window.__chartLight('bench'));
  console.log(JSON.stringify({ log: lines.filter((l) => /page|charts|padded/.test(l)), charts }, null, 1).slice(0, 2200));
} finally { await browser.close(); }
