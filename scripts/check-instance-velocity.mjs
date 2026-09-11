/* @important Motion vectors of static InstancedMesh, and the TAA shimmer they cause.

     node scripts/check-instance-velocity.mjs      # headed Chrome, PORT=5188 by default

   The village is instanced (85 InstancedMesh against 96 plain Mesh); the beach is not.
   three r182 builds the current clip position from `positionLocal`, which InstanceNode
   has multiplied by `instanceMatrix`, and the previous one from `positionPrevious`
   (= `positionGeometry`), which it has not - so a motionless instance reports its whole
   placement as velocity and TAA resolves its history from the wrong pixels.

   Two boots of the same still frame, `?instanceMotion=0` (three's node) against the
   default (installStaticMotion): velocity over instanced pixels must fall to ~0 with
   the fix, the frame-to-frame difference of the resolved image - the shimmer the user
   sees - must fall with it, and a moving camera must still write velocity, or TAA
   would smear instead. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const port = process.env.PORT ?? '5188';
const scene = process.env.SCENE ?? 'midsee-village';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });

const frames = (page, n) => page.evaluate((k) => new Promise((res) => {
  let i = 0;
  const tick = () => (++i >= k ? res(true) : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

async function session(instanceMotion) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  let fatal = null;
  page.on('pageerror', (e) => { fatal ??= String(e); });
  page.on('console', (m) => { if (m.type() === 'error') fatal ??= m.text(); });
  await page.goto(`http://127.0.0.1:${port}/?scene=${scene}&hud=0&still=1&grain=0&aa=taa&instanceMotion=${instanceMotion}`);
  const booted = await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: Number(process.env.BOUND ?? 30000) }).then(() => true).catch(() => false);
  assert.ok(booted && !fatal, `boot failed (instanceMotion=${instanceMotion}): ${fatal ?? 'timeout'}`);

  await frames(page, 60);
  const shimmerSample = await page.evaluate(async () => {
    const read = async () => (await window.__fog.taaFrame()).data;
    const wait = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    let worst = 0;
    let jitters = new Set();
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

  assert.ok(shimmerSample.jitters > 1, `the frame loop stalled during the shimmer measurement (instanceMotion=${instanceMotion}): ${shimmerSample.jitters} distinct jitters`);
  const shimmer = shimmerSample.worst;
  await page.evaluate(() => window.__fog.frameGraph().scenePass.scene.traverse((o) => { if (o.isMesh) o.visible = !!o.isInstancedMesh; }));
  await frames(page, 20);
  const still = await page.evaluate(async () => {
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

  await page.evaluate(() => new Promise((res) => {
    const camera = window.__fog.frameGraph().camera;
    let i = 0;
    const step = () => { camera.position.x += 0.05; camera.updateMatrixWorld(true); if (++i >= 6) res(true); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }));
  const moving = await page.evaluate(async () => {
    const f = await window.__fog.velocityFrame();
    let sum = 0;
    const n = f.width * f.height;
    for (let i = 0; i < n; i++) sum += Math.hypot(f.data[i * 4] * 0.5 * f.width, f.data[i * 4 + 1] * 0.5 * f.height);
    return sum / n;
  });

  await page.close();
  assert.ok(!fatal, `console error (instanceMotion=${instanceMotion}): ${fatal}`);
  return { shimmer, still, moving };
}

const off = await session(0);
const on = await session(1);
await browser.close();

console.log(JSON.stringify({
  off: { staticMeanPx: +off.still.mean.toFixed(3), staticMovingFraction: +off.still.movingFraction.toFixed(4), shimmer255: +off.shimmer.toFixed(3), cameraMeanPx: +off.moving.toFixed(3) },
  on: { staticMeanPx: +on.still.mean.toFixed(3), staticMovingFraction: +on.still.movingFraction.toFixed(4), shimmer255: +on.shimmer.toFixed(3), cameraMeanPx: +on.moving.toFixed(3) },
}, null, 2));

assert.ok(off.still.mean > 1, `the ablation must reproduce the defect, measured ${off.still.mean.toFixed(3)} px`);
assert.ok(on.still.mean < 0.01, `static instances must not move, measured ${on.still.mean.toFixed(3)} px`);
assert.ok(on.shimmer < off.shimmer * 0.6, `TAA shimmer must fall: ${on.shimmer.toFixed(3)} against ${off.shimmer.toFixed(3)}`);
assert.ok(on.moving > 0.01, `a moving camera must still write velocity, measured ${on.moving.toFixed(3)} px`);
console.log('OK');
