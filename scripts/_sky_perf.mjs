import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const port = process.env.PORT ?? '5230';
const out = process.env.OUT ?? 'shots/critic/fps';
mkdirSync(out, { recursive: true });
const variants = JSON.parse(process.env.VARIANTS ?? '[{"name":"default"}]');
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: Number(process.env.W ?? 1600), height: Number(process.env.H ?? 900) } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const finish = async (code) => { if (errors.length) console.log('ERRORS', errors.slice(0, 4)); await browser.close(); process.exit(code); };
await page.goto(`http://127.0.0.1:${port}/?scene=sky&cam=${process.env.CAM ?? 'horizon'}&hud=0&${process.env.QUERY ?? ''}`);
const ok = await page.waitForFunction(() => {
  const error = document.querySelector('#error-overlay');
  if (error && !error.hidden && !error.classList.contains('hidden')) return 'error';
  return window.__sky && document.querySelector('#loading-overlay')?.hidden ? 'ready' : false;
}, null, { timeout: 150000, polling: 250 }).then((h) => h.jsonValue()).catch(() => 'timeout');
if (ok !== 'ready' || errors.length) { console.log('FAIL boot', ok); await finish(1); }
for (const variant of variants) {
  await page.evaluate((v) => { Object.assign(window.__sky.clouds, v.clouds ?? {}); Object.assign(window.__sky.settings, v.sky ?? {}); if (v.sun) window.__audit.sun(...v.sun); if (v.camera) window.__camera(...v.camera); }, variant);
  await page.waitForTimeout(Number(process.env.SETTLE ?? 3000));
  if (errors.length) { console.log('FAIL', variant.name); await finish(1); }
  const fps = await page.evaluate((sweep) => new Promise((resolve) => { let frames = 0; const start = performance.now(); const tick = () => { frames++; if (sweep) window.__audit.sun(-60, 5 + (frames % 300) * 0.1); if (performance.now() - start < 3000) requestAnimationFrame(tick); else resolve(frames / ((performance.now() - start) / 1000)); }; requestAnimationFrame(tick); }), variant.sweep === true);
  await page.screenshot({ path: `${out}/${variant.name}.png` });
  console.log(`${variant.name} fps ${fps.toFixed(1)} cam ${JSON.stringify(await page.evaluate(() => { const p = window.__probe(); return [p.camera, p.target]; }))}`);
}
await finish(0);
