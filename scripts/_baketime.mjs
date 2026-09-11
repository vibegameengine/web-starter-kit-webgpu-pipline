import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on('console', (m) => { const t = m.text(); if (/\[lightmap\]|\[bake\]/.test(t)) console.log(t.slice(0, 180)); });
  page.on('pageerror', (e) => console.log(`pageerror: ${String(e).slice(0, 200)}`));
  const started = Date.now();
  await page.goto(`http://127.0.0.1:${process.env.PORT ?? '5188'}/?scene=${process.env.SCENE ?? 'midsee-village'}&cam=quay&bakeCache=0`);
  await page.waitForFunction(() => {
    const overlay = document.querySelector('#loading-overlay');
    return Boolean(window.__audit) && (!overlay || overlay.hidden || !overlay.offsetParent);
  }, null, { timeout: Number(process.env.BOUND ?? 420000) });
  console.log(`booted in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  await page.addStyleTag({ content: '.lil-gui, #hud { display: none !important; }' });
  await page.evaluate(() => window.__audit.hideOverlay());
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `shots/${process.env.TAG ?? 'bake'}.png`, timeout: 60000, animations: 'disabled' });
  console.log('shot done');
} finally { await browser.close(); }
