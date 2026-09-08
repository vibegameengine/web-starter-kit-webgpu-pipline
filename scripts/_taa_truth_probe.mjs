// Ground truth for the TAA: average of the eight jittered scene-pass frames of a still
// scene (what a converged resolve should output), compared with one jittered frame and
// with the resolve's actual output — all in the same linear domain. Headed.
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const quiet = '&contact=0&reflections=0&gi=0&shadowFilter=receiverPlane&glare=0&fog=0';
await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&still=1&cam=leaves&grain=0&exposure=1${quiet}${process.argv[2] ?? ''}`);
await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
await page.waitForTimeout(4000);
const r = await page.evaluate(async () => {
  const phases = new Map();
  let single = null, width = 0, height = 0;
  for (let i = 0; i < 64 && phases.size < 8; i++) {
    const j = window.__fog.taaState().jitter.join(',');
    const f = await window.__fog.taaInputFrame();
    width = f.width; height = f.height;
    if (!phases.has(j)) { phases.set(j, f.data); if (!single) single = f.data; }
    await new Promise((res) => requestAnimationFrame(res));
  }
  const frames = [...phases.values()];
  const avg = new Float32Array(single.length);
  for (const d of frames) for (let k = 0; k < d.length; k++) avg[k] += d[k] / frames.length;
  const resolved = (await window.__fog.taaFrame()).data;
  const srgb = (v) => Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.2) * 255;
  const luma = (d, x, y) => { const p = (y * width + x) * 4; return 0.2126 * srgb(d[p]) + 0.7152 * srgb(d[p + 1]) + 0.0722 * srgb(d[p + 2]); };
  const steps = (d) => { let n = 0; for (let y = 100; y < 500; y++) for (let x = 401; x < 1300; x++) if (Math.abs(luma(d, x, y) - luma(d, x - 1, y)) > 48) n++; return n; };
  const diff = (a, b) => { let d = 0, n = 0; for (let y = 100; y < 500; y++) for (let x = 400; x < 1300; x++) { const p = (y * width + x) * 4; d += Math.abs(srgb(a[p]) - srgb(b[p])) + Math.abs(srgb(a[p+1]) - srgb(b[p+1])) + Math.abs(srgb(a[p+2]) - srgb(b[p+2])); n += 3; } return d / n; };
  return { phases: phases.size, steps: { single: steps(single), average: steps(avg), resolved: steps(resolved) }, resolvedVsAverage: diff(resolved, avg), singleVsAverage: diff(single, avg) };
});
console.log(JSON.stringify(r));
await browser.close();
