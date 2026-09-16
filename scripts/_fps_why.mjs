import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';

const port = process.env.PORT ?? '5188';
const scene = process.env.SCENE ?? 'midsee-village';
const variants = (process.env.VARIANTS ?? '').split(',');
const gate = Number(process.env.GATE_MS ?? 420000);
const timer = setTimeout(() => { console.error('gate'); process.exit(2); }, gate);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (error) => { console.error('pageerror:', String(error).slice(0, 300)); process.exit(3); });
page.on('console', (message) => { const t = message.text(); if (/\[bake-cache\]|\[lod\]|\[BVH/.test(t)) console.log('  console:', t.slice(0, 200)); });
for (const extra of variants) {
  const started = Date.now();
  await page.goto(`http://127.0.0.1:${port}/?scene=${scene}${extra}`);
  await bootOrFail(page, 300000);
  console.log(`${extra || 'default'} booted in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  await page.evaluate(() => new Promise((resolve) => { let n = 0; const tick = () => (++n > 600 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }));
  const timing = await page.evaluate(() => new Promise((resolve) => {
    const intervals = []; let last = performance.now();
    const tick = () => { const now = performance.now(); intervals.push(now - last); last = now; if (intervals.length < 240) requestAnimationFrame(tick); else resolve(intervals); };
    requestAnimationFrame(tick);
  }));
  timing.sort((a, b) => a - b);
  console.log(`  rAF interval median ${timing[120].toFixed(2)} ms, p90 ${timing[216].toFixed(2)} ms`);
  const gpu = await page.evaluate(() => window.__gpuPasses?.(60)).catch((error) => ({ error: String(error) }));
  if (gpu?.passes) {
    console.log(`  inspector frame ${gpu.frameMs?.toFixed(2)} ms, gpu sum ${gpu.gpuMs?.toFixed(2)} ms, frames ${gpu.framesUsed}`);
    for (const pass of gpu.passes.slice(0, Number(process.env.PASSES ?? 0))) console.log(`    gpu ${pass.gpu.toFixed(2)} cpu ${pass.cpu.toFixed(2)} x${pass.perFrame} ${pass.name}`);
    const cpu = gpu.passes.reduce((sum, pass) => sum + pass.cpu * 1, 0);
    console.log(`  cpu sum over passes ${cpu.toFixed(2)} ms`);
  } else console.log('  gpuPasses', JSON.stringify(gpu)?.slice(0, 200));
}
clearTimeout(timer);
await browser.close();
