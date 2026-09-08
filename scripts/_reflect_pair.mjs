// Reflections traced every frame vs every other frame: still camera and a slow pan,
// mean |luma| difference over the frame and over the water region. Headed, gate 3 min.
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { mkdir, writeFile } from 'node:fs/promises';
setTimeout(() => { console.error('gate: 3 minutes, abort'); process.exit(2); }, 180000);
await mkdir('shots/reflect', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const luma = (img, i) => 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
const diff = (a, b, [rx, ry, rw, rh]) => { let s = 0, n = 0; for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) { const i = (y * a.width + x) * 4; s += Math.abs(luma(a, i) - luma(b, i)); n++; } return s / n; };
const shot = async (every, panning, name) => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&still=1&cam=water&grain=0&exposure=1&waterSim=0&reflectionsEvery=${every}`);
  await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 120000 });
  await page.evaluate(() => new Promise((resolve) => { let last = performance.now(), run = 0; const f = () => { const t = performance.now(); run = t - last < 500 ? run + 1 : 0; last = t; if (run >= 40) resolve(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
  if (panning) await page.evaluate(() => new Promise((resolve) => {
    const c = window.__probe(); const p = c.camera, t = c.target;
    const dx = t[0] - p[0], dz = t[2] - p[2];
    let frame = 0;
    const tick = () => { frame += 1; const a = frame * 0.25 * Math.PI / 180; window.__camera(p[0], p[1], p[2], p[0] + dx * Math.cos(a) - dz * Math.sin(a), t[1], p[2] + dx * Math.sin(a) + dz * Math.cos(a)); if (frame === 30) { window.__audit.pause(true); resolve(); return; } requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }));
  const png = await page.screenshot(); await writeFile(`shots/reflect/${name}.png`, png); await page.close();
  return PNG.sync.read(png);
};
const water = [200, 450, 1200, 400];
for (const panning of [false, true]) {
  const a = await shot(1, panning, panning ? 'pan-every1' : 'still-every1');
  const b = await shot(2, panning, panning ? 'pan-every2' : 'still-every2');
  const c = await shot(1, panning, panning ? 'pan-every1b' : 'still-every1b');
  console.log(`${panning ? 'pan ' : 'still'}: every2 vs every1 ${diff(a, b, water).toFixed(2)}/255 in the water, ${diff(a, b, [0, 0, 1600, 900]).toFixed(2)} over the frame; run-to-run drift of every1 ${diff(a, c, water).toFixed(2)}`);
}
await browser.close();
