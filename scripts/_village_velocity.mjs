import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const port = process.env.PORT ?? '5192';
const scene = process.env.SCENE ?? 'midsee-village';
const cam = process.env.CAM ? `&cam=${process.env.CAM}` : '';
const url = `http://127.0.0.1:${port}/?scene=${scene}&hud=0&still=1&grain=0&aa=taa${cam}`;

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
let fatal = null;
page.on('pageerror', (e) => { fatal = String(e); });
page.on('console', (m) => { if (m.type() === 'error') fatal ??= m.text(); });

const die = async (why) => { console.error('FAIL', why); await browser.close(); process.exit(1); };

await page.goto(url);
const booted = await Promise.race([
  page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 150000 }).then(() => 'ok').catch((e) => String(e)),
  new Promise((r) => setTimeout(() => r(fatal ? `pageerror ${fatal}` : 'timeout'), 155000)),
]);
if (booted !== 'ok' || fatal) await die(`boot: ${booted} ${fatal ?? ''}`);

const frames = (n) => page.evaluate((k) => new Promise((res) => {
  let i = 0;
  const tick = () => (++i >= k ? res(true) : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

const stats = async (label) => {
  await frames(30);
  const r = await page.evaluate(async () => {
    const f = await window.__fog.velocityFrame();
    const w = f.width, h = f.height, d = f.data;
    let moving = 0, covered = 0, sum = 0, max = 0;
    const px = Math.max(w, h) * 0.5;
    for (let i = 0; i < w * h; i++) {
      const vx = d[i * 4] * 0.5 * w, vy = d[i * 4 + 1] * 0.5 * h;
      const m = Math.hypot(vx, vy);
      if (!Number.isFinite(m)) continue;
      covered++;
      sum += m;
      if (m > max) max = m;
      if (m > 0.05) moving++;
    }
    return { w, h, px, covered, movingFraction: moving / Math.max(1, covered), mean: sum / Math.max(1, covered), max };
  });
  console.log(label, JSON.stringify({ movingFraction: +r.movingFraction.toFixed(4), meanPx: +r.mean.toFixed(4), maxPx: +r.max.toFixed(3) }));
  return r;
};

const setVisible = (mode) => page.evaluate((m) => {
  const root = window.__fog.frameGraph().scenePass.scene;
  let instanced = 0, plain = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.isInstancedMesh) { instanced++; o.userData.__probeHidden = m === 'plain'; }
    else { plain++; o.userData.__probeHidden = m === 'instanced'; }
    if (m === 'all') o.userData.__probeHidden = false;
    o.visible = !o.userData.__probeHidden;
  });
  return { instanced, plain };
}, mode);

const moveCamera = () => page.evaluate(() => new Promise((res) => {
  const camera = window.__fog.frameGraph().camera;
  let i = 0;
  const step = () => {
    camera.position.x += 0.05;
    camera.updateMatrixWorld(true);
    if (++i >= 6) res(true); else requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}));

const counts = await setVisible('all');
console.log('meshes', JSON.stringify(counts));
const all = await stats('all       ');
const plainOnly = (await setVisible('plain'), await stats('plain only'));
const instancedOnly = (await setVisible('instanced'), await stats('instanced '));
await setVisible('instanced');
await moveCamera();
const instancedMoving = await page.evaluate(async () => {
  const f = await window.__fog.velocityFrame();
  const w = f.width, h = f.height, d = f.data;
  let moving = 0, sum = 0;
  for (let i = 0; i < w * h; i++) {
    const m = Math.hypot(d[i * 4] * 0.5 * w, d[i * 4 + 1] * 0.5 * h);
    if (m > 0.05) moving++;
    sum += m;
  }
  return { movingFraction: moving / (w * h), mean: sum / (w * h) };
});
console.log('instanced, camera moving', JSON.stringify({ movingFraction: +instancedMoving.movingFraction.toFixed(4), meanPx: +instancedMoving.mean.toFixed(3) }));
await setVisible('all');

console.log(JSON.stringify({ scene, counts, all: all.movingFraction, plainOnly: plainOnly.movingFraction, instancedOnly: instancedOnly.movingFraction, instancedCameraMoving: +instancedMoving.mean.toFixed(3) }));
if (fatal) await die(`console ${fatal}`);
await browser.close();
assert.ok(true);
