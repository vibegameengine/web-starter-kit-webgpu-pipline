import { chromium } from 'playwright';
const port = process.env.PORT ?? '5188';
const variants = JSON.parse(process.env.VARIANTS ?? '[{}]');
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${port}/?scene=sky&cam=${process.env.CAM ?? 'horizon'}&hud=0&${process.env.QUERY ?? ''}`);
const ok = await page.waitForFunction(() => window.__sky && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 150000 }).then(() => true).catch(() => false);
if (!ok || errors.length) { console.log('FAIL', errors.slice(0, 4)); await browser.close(); process.exit(1); }
for (const [index, variant] of variants.entries()) {
  await page.evaluate((v) => { Object.assign(window.__sky.clouds, v.clouds ?? {}); if (v.sun) window.__audit.sun(...v.sun); if (v.camera) window.__camera(...v.camera); }, variant);
  await page.waitForTimeout(3500);
  if (errors.length) { console.log('FAIL', errors.slice(0, 4)); break; }
  await page.screenshot({ path: `${process.env.OUT}/${variant.name ?? index}.png` });
  const fps = await page.evaluate(() => new Promise((resolve) => { let frames = 0; const start = performance.now(); const tick = () => { frames++; if (performance.now() - start < 3000) requestAnimationFrame(tick); else resolve(frames / ((performance.now() - start) / 1000)); }; requestAnimationFrame(tick); }));
  console.log('fps', variant.name ?? index, fps.toFixed(1));
  console.log('shot', variant.name ?? index);
}
await browser.close();
