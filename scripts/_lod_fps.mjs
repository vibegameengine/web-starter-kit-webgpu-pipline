import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';

const port = process.env.PORT ?? '5188';
const query = process.env.QUERY ?? 'scene=village-light&iters=32&rays=8&probes=0&bakeCache=0';
const gate = Number(process.env.GATE_MS ?? 200000);
const timer = setTimeout(() => { console.error('gate'); process.exit(2); }, gate);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (error) => { console.error('pageerror:', String(error).slice(0, 300)); process.exit(3); });
for (const extra of (process.env.VARIANTS ?? '&lod=0,').split(',')) {
  await page.goto(`http://127.0.0.1:${port}/?${query}${extra}&hud=0`);
  await bootOrFail(page, 120000);
  for (let i = 0; i < 3; i++) {
    const frames = await page.evaluate(() => new Promise((resolve) => { let n = 0; const t0 = performance.now(); const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else resolve(n); }; requestAnimationFrame(tick); }));
    const lod = await page.evaluate(() => { const r = window.__lod?.(); return r && { frame: r.feedbackFrame, reading: r.feedbackReading, reads: r.feedbackReads, drawn: r.feedbackDrawn, asked: r.asked, resident: r.resident, rootOnly: r.rootOnly, mips: r.mips }; });
    const info = await page.evaluate(() => window.__audit?.frame?.() ?? null).catch(() => null);
    console.log(extra || 'lod', 'rAF/2s', frames, JSON.stringify(lod), JSON.stringify(info)?.slice(0, 120));
  }
}
clearTimeout(timer);
await browser.close();
