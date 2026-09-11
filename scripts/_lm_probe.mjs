import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';
import { mkdir } from 'node:fs/promises';

const out = 'shots/lm-probe';
await mkdir(out, { recursive: true });
const query = process.env.LM_QUERY ?? '?scene=corridor&cam=bench';
const tag = process.env.LM_TAG ?? 'corridor-bench';

const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const lines = [];
  page.on('console', m => { const t = m.text(); if (/lightmap|bake|chart|atlas/i.test(t)) lines.push(`${m.type()}: ${t}`); });
  page.on('pageerror', e => lines.push(`pageerror: ${e}`));
  await page.goto(`http://127.0.0.1:5188/${query}`);
  await bootOrFail(page);
  await page.addStyleTag({ content: '.lil-gui, #hud { display: none !important; }' });
  await page.evaluate(() => window.__audit?.hideOverlay?.());
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}/${tag}.png` });
  console.log(JSON.stringify({ tag, query, lines }, null, 1));
} finally { await browser.close(); }
