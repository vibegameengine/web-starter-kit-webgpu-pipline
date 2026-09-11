import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';
import { mkdir } from 'node:fs/promises';
const out = 'shots/lod';
await mkdir(out, { recursive: true });
const query = process.env.LOD_QUERY ?? '?scene=corridor&cam=bench&lod=1';
const tag = process.env.LOD_TAG ?? 'lod';
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:5188/${query}`);
  await bootOrFail(page);
  await page.addStyleTag({ content: '.lil-gui, #hud { display: none !important; }' });
  await page.evaluate(() => window.__audit?.hideOverlay?.());
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/${tag}.png` });
  const lod = await page.evaluate(() => window.__lod?.());
  console.log(JSON.stringify({ tag, query, lod, errors: errors.slice(0, 4) }, null, 1));
} finally { await browser.close(); }
