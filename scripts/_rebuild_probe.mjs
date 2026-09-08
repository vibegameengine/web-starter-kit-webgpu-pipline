// Does the composite graph get rebuilt every frame, and who marks it dirty?
import { chromium } from 'playwright';
setTimeout(() => { console.error('gate: 3 minutes, abort'); process.exit(2); }, 180000);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0${process.argv[2] ?? ''}`);
await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 170000 });
await page.evaluate(() => new Promise((resolve) => { let last = performance.now(), run = 0; const f = () => { const t = performance.now(); run = t - last < 500 ? run + 1 : 0; last = t; if (run >= 30) resolve(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
const r = await page.evaluate(() => new Promise((resolve) => {
  const fg = window.__fog.frameGraph();
  const stacks = [];
  let rebuilds = 0, frames = 0;
  const originalRebuild = fg.rebuildComposite.bind(fg);
  fg.rebuildComposite = () => { rebuilds++; stacks.push(new Error().stack.split('\n').slice(2, 5).map((l) => l.trim().replace(/^at /, '').replace(/https?:\/\/[^/]+\//, '').replace(/\?[^:)]*/, '')).join(' <- ')); return originalRebuild(); };
  // Who sets needsComposite?
  let value = fg.needsComposite;
  const marks = [];
  Object.defineProperty(fg, 'needsComposite', {
    get: () => value,
    set: (v) => { if (v && !value) marks.push(new Error().stack.split('\n').slice(2, 5).map((l) => l.trim().replace(/^at /, '').replace(/https?:\/\/[^/]+\//, '').replace(/\?[^:)]*/, '')).join(' <- ')); value = v; },
    configurable: true,
  });
  const tick = () => { frames++; if (frames > 30) { resolve({ frames, rebuilds, stacks: [...new Set(stacks)].slice(0, 3), marks: [...new Set(marks)].slice(0, 4) }); return; } requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}));
console.log(`${r.rebuilds} composite rebuilds in ${r.frames} frames`);
if (r.stacks.length) console.log('rebuild callers:\n  ' + r.stacks.join('\n  '));
if (r.marks.length) console.log('marked dirty by:\n  ' + r.marks.join('\n  '));
await browser.close();
