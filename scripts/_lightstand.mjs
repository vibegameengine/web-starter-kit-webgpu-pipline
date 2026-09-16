import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';
import { mkdir } from 'node:fs/promises';
await mkdir('shots/wall', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  page.on('console', (m) => { const t = m.text(); if (/lod-lab|\[lod\]|\[lightmap\]/.test(t)) console.log(`page: ${t.slice(0, 180)}`); });
  page.on('pageerror', (e) => console.log(`pageerror: ${String(e).slice(0, 200)}`));
  const started = Date.now();
  await page.goto(`${process.env.DEV_URL ?? 'http://127.0.0.1:5191'}/?scene=village-light${process.env.EXTRA ?? ''}`);
  await bootOrFail(page, 180000);
  console.log(`booted in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  await page.addStyleTag({ content: '.lil-gui, #hud { display: none !important; }' });
  await page.evaluate(() => window.__audit.hideOverlay());
  const settled = await page.evaluate(async (bound) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    let started = 0;
    let quiet = 0;
    const deadline = Date.now() + bound;
    while (Date.now() < deadline) {
      await frame();
      const lod = window.__lod?.();
      if (!lod || lod.visible === 0) { quiet = 0; continue; }
      if (started === 0) started = Date.now();
      quiet = lod.copies === 0 && lod.refused === 0 ? quiet + 1 : 0;
      if (quiet >= 30) return { settledMs: Date.now() - started, ...lod, mips: JSON.stringify(lod.mips) };
    }
    return { settledMs: null, ...(window.__lod?.() ?? {}) };
  }, Number(process.env.SETTLE_BOUND ?? 60000));
  console.log(`settled: ${JSON.stringify(settled).slice(0, 400)}`);
  await page.screenshot({ path: `shots/wall/${process.env.TAG ?? 'light'}.png`, timeout: 60000, animations: 'disabled' });
  console.log('shot done');
} finally { await browser.close(); }
