/* @important Motion vectors of static InstancedMesh.

     node scripts/check-instance-velocity.mjs                 # headed Chrome, PORT=5188
     VITE_THREE_STOCK=1 npm run dev                           # the ablation: stock three

   Stock three r182 builds the current clip position from `positionLocal`, which
   InstanceNode has multiplied by `instanceMatrix`, and the previous one from
   `positionPrevious` (= `positionGeometry`), which it has not - so a motionless instance
   reports its whole placement as velocity, TAA resolves history from the wrong pixels,
   and the village shimmers while the beach (plain meshes) does not. `vendor/three` is
   our fork of mrdoob/three.js on branch `r182-instance-velocity`: r182 plus #32586 and
   #32615, which give InstanceNode a previous instance matrix.

   This asserts the fork is the three actually being served: a still scene writes no
   velocity over instanced pixels, while a moving camera still does (writing zero
   everywhere would kill the shimmer by making TAA smear instead). Measured on
   `?scene=village-light`: 0 px still, 0.21 px moving, shimmer 0.42/255 - against
   118.7 px and 2.84/255 with `VITE_THREE_STOCK=1`. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const port = process.env.PORT ?? '5188';
const scene = process.env.SCENE ?? 'village-light';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
let fatal = null;
page.on('pageerror', (e) => { fatal ??= String(e); });
page.on('console', (m) => { if (m.type() === 'error') fatal ??= m.text(); });

const frames = (n) => page.evaluate((k) => new Promise((res) => {
  let i = 0;
  const tick = () => (++i >= k ? res(true) : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

const instancedVelocity = () => page.evaluate(async () => {
  const f = await window.__fog.velocityFrame();
  let moving = 0, sum = 0;
  const n = f.width * f.height;
  for (let i = 0; i < n; i++) {
    const m = Math.hypot(f.data[i * 4] * 0.5 * f.width, f.data[i * 4 + 1] * 0.5 * f.height);
    sum += m;
    if (m > 0.05) moving++;
  }
  return { mean: sum / n, movingFraction: moving / n };
});

await page.goto(`http://127.0.0.1:${port}/?scene=${scene}&hud=0&still=1&grain=0&aa=taa`);
const booted = await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: Number(process.env.BOUND ?? 60000) }).then(() => true).catch(() => false);
assert.ok(booted && !fatal, `boot failed: ${fatal ?? 'timeout'}`);

await frames(60);
const shimmer = await page.evaluate(async () => {
  const read = async () => (await window.__fog.taaFrame()).data;
  const wait = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const jitters = new Set();
  let worst = 0;
  let previous = await read();
  for (let k = 0; k < 6; k++) {
    await wait();
    jitters.add(window.__fog.taaState().jitter.join(','));
    const current = await read();
    let sum = 0;
    for (let i = 0; i < current.length; i += 4) sum += Math.abs(current[i] - previous[i]) + Math.abs(current[i + 1] - previous[i + 1]) + Math.abs(current[i + 2] - previous[i + 2]);
    worst = Math.max(worst, sum / (current.length / 4) * 255);
    previous = current;
  }
  return { worst, jitters: jitters.size };
});
assert.ok(shimmer.jitters > 1, `the frame loop stalled: ${shimmer.jitters} distinct TAA jitters over the measurement`);

const instancedMeshes = await page.evaluate(() => {
  let instanced = 0;
  window.__fog.frameGraph().scenePass.scene.traverse((o) => { if (o.isMesh) { if (o.isInstancedMesh) instanced++; o.visible = !!o.isInstancedMesh; } });
  return instanced;
});
assert.ok(instancedMeshes > 0, 'the scene has no InstancedMesh to measure');
await frames(20);
const still = await instancedVelocity();

await page.evaluate(() => new Promise((res) => {
  const camera = window.__fog.frameGraph().camera;
  let i = 0;
  const step = () => { camera.position.x += 0.05; camera.updateMatrixWorld(true); if (++i >= 6) res(true); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}));
const moving = await instancedVelocity();

await browser.close();
console.log(JSON.stringify({
  instancedMeshes,
  stillMeanPx: +still.mean.toFixed(3),
  stillMovingFraction: +still.movingFraction.toFixed(4),
  cameraMeanPx: +moving.mean.toFixed(3),
  shimmer255: +shimmer.worst.toFixed(3),
}, null, 2));

assert.ok(!fatal, `console error: ${fatal}`);
assert.ok(still.mean < 0.01, `static instances must not move, measured ${still.mean.toFixed(3)} px — is vendor/three aliased?`);
assert.ok(moving.mean > 0.01, `a moving camera must still write velocity, measured ${moving.mean.toFixed(3)} px`);
assert.ok(shimmer.worst < 1, `TAA must be settled on a still scene, measured ${shimmer.worst.toFixed(3)} /255`);
console.log('OK');
