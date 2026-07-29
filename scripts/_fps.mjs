// Steady-state frame time for a given URL. Prints median/mean ms over N frames.
// Usage: node scripts/_fps.mjs "<url>" [warmupMs] [frames]
import { chromium } from 'playwright';

const url = process.argv[2];
const warmup = Number(process.argv[3] ?? 16000);
const frames = Number(process.argv[4] ?? 120);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--use-angle=d3d11',
    '--enable-webgpu-developer-features',
    '--no-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(warmup);

const samples = await page.evaluate(
  (n) =>
    new Promise((resolve) => {
      const out = [];
      let last = performance.now();
      const tick = () => {
        const now = performance.now();
        out.push(now - last);
        last = now;
        if (out.length < n) requestAnimationFrame(tick);
        else resolve(out);
      };
      requestAnimationFrame(tick);
    }),
  frames,
);

const sorted = [...samples].slice(2).sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
console.log(
  JSON.stringify({
    url,
    medianMs: +median.toFixed(2),
    meanMs: +mean.toFixed(2),
    fps: +(1000 / median).toFixed(1),
  }),
);
await browser.close();
