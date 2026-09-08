// Every renderer.render / compute call of one frame: scene name, target, size, caller.
import { chromium } from 'playwright';
setTimeout(() => { console.error('gate: 3 minutes, abort'); process.exit(2); }, 180000);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0${process.argv[2] ?? ''}`);
await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 170000 });
await page.evaluate(() => new Promise((resolve) => { let last = performance.now(), run = 0; const f = () => { const t = performance.now(); run = t - last < 500 ? run + 1 : 0; last = t; if (run >= 30) resolve(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
const r = await page.evaluate(() => new Promise((resolve) => {
  const fg = window.__fog.frameGraph();
  const renderer = fg.renderer;
  const original = renderer.render.bind(renderer);
  const calls = [];
  let frame = 0, on = false;
  renderer.render = (scene, camera) => {
    if (on) {
      const rt = renderer.getRenderTarget();
      const who = new Error().stack.split('\n').slice(2, 6).map((l) => l.trim().replace(/^at /, '').replace(/\(.*\//, '(').replace(/\?[^:)]*/, '')).join(' <- ');
      calls.push(`${scene.name || scene.type || '?'} -> ${rt ? `${rt.texture?.name || rt.textures?.[0]?.name || 'rt'} ${rt.width}x${rt.height}` : 'screen'}   ${who}`);
    }
    return original(scene, camera);
  };
  const tick = () => { frame += 1; if (frame === 2) on = true; if (frame === 3) { on = false; renderer.render = original; resolve(calls); return; } requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}));
console.log(r.join('\n'));
await browser.close();
