/* @important One page, one warm-up, interleaved blocks: the look is switched on and off at
   runtime and the blocks alternate, so the shared machine's drift - other agents' browsers,
   thermal, the compositor - lands on both sides equally. Absolute milliseconds from this
   machine mean nothing today; the paired difference is what the question asks. */
import { chromium } from 'playwright';

setTimeout(() => { console.error('gate: 10 minutes, abort'); process.exit(2); }, 600000);

const PORT = process.env.DEV_PORT ?? '5190';
const SCENE = process.env.COST_SCENE ?? 'corridor';
const CAM = process.env.COST_CAM ?? 'hero';
const BLOCK_FRAMES = 180;
const ROUNDS = 5;
const WARMUP_FRAMES = 300;
const ACCEPTABLE_MS = 0.3;

const chromeArgs = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--no-sandbox'];

const sample = (page, frames) => page.evaluate((count) => new Promise((resolve) => {
  const intervals = [];
  let last = performance.now();
  const step = () => {
    const now = performance.now();
    intervals.push(now - last);
    last = now;
    if (intervals.length >= count) resolve(intervals);
    else requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}), frames);

/* @important The floor, not the median: with other agents driving their own browsers on
   this machine, a block's median is mostly their interference, while the fastest frames in
   the block are the ones that ran while the machine was briefly ours. A cost that is real
   raises the floor too. */
const floor = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.floor(sorted.length * 0.05))];
};
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: chromeArgs });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

let verdict = 1;
try {
  await page.goto(`http://127.0.0.1:${PORT}/?scene=${SCENE}&cam=${CAM}&hud=0&still=1&inspector=0`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const ready = await page.waitForFunction(() => {
    const error = document.querySelector('#error-overlay');
    if (error && !error.hidden && !error.classList.contains('hidden')) return { error: document.querySelector('#error-message')?.textContent ?? 'error overlay' };
    const loading = document.querySelector('#loading-overlay');
    return (!loading || loading.hidden || loading.classList.contains('hidden')) && window.__fog ? { ready: true } : false;
  }, null, { timeout: 400000, polling: 500 }).then((handle) => handle.jsonValue());
  if (ready.error) throw new Error(`pipeline error: ${ready.error}`);
  await sample(page, WARMUP_FRAMES);

  const WORKING = { exposureEV: 0.5, indirectEV: 0.35, saturation: 1.06, contrast: 1.04 };
  const NEUTRAL = { exposureEV: 0, indirectEV: 0, saturation: 1, contrast: 1 };
  const blocks = { on: [], off: [], working: [] };
  const order = [['off', 'on', 'working'], ['working', 'on', 'off'], ['on', 'working', 'off']];
  for (let round = 0; round < ROUNDS; round++) {
    for (const state of order[round % order.length]) {
      await page.evaluate(([enabled, look]) => { window.__fog.lookEnabled(enabled); window.__fog.lookApply(look); },
        [state !== 'off', state === 'working' ? WORKING : NEUTRAL]);
      await sample(page, 60);
      blocks[state].push(floor(await sample(page, BLOCK_FRAMES)));
    }
  }

  const off = median(blocks.off);
  const on = median(blocks.on);
  const working = median(blocks.working);
  const spread = Math.max(Math.max(...blocks.off) - Math.min(...blocks.off), Math.max(...blocks.on) - Math.min(...blocks.on));
  console.log(`look off   floor ${off.toFixed(2)} ms   blocks ${blocks.off.map((v) => v.toFixed(2)).join(' ')}`);
  console.log(`look on    floor ${on.toFixed(2)} ms   blocks ${blocks.on.map((v) => v.toFixed(2)).join(' ')}`);
  console.log(`working    floor ${working.toFixed(2)} ms   blocks ${blocks.working.map((v) => v.toFixed(2)).join(' ')}`);
  console.log(`delta neutral ${(on - off >= 0 ? '+' : '')}${(on - off).toFixed(2)} ms, working ${(working - off >= 0 ? '+' : '')}${(working - off).toFixed(2)} ms, against a same-state spread of ${spread.toFixed(2)} ms`);
  const noise = Math.max(ACCEPTABLE_MS, spread);
  const grew = Math.max(on - off, working - off);
  console.log(grew <= noise
    ? `ok   the frame did not grow: the largest difference ${grew.toFixed(2)} ms is inside this machine's own ${noise.toFixed(2)} ms spread`
    : `FAIL the frame grew by ${grew.toFixed(2)} ms, past the ${noise.toFixed(2)} ms spread`);
  if (errors.length) console.log(`page errors: ${errors.slice(0, 2).join(' | ')}`);
  verdict = grew <= noise && errors.length === 0 ? 0 : 1;
} catch (error) {
  console.log(`FAIL ${error.message}`);
} finally {
  await browser.close();
}
process.exit(verdict);
