import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { mkdirSync } from 'node:fs';

const SCENE = process.env.LOOK_SCENE ?? 'beach';
const CAM = process.env.LOOK_CAM ?? 'shore';
const EXPOSURE = 0.5;
const URL = `http://127.0.0.1:5188/?scene=${SCENE}&cam=${CAM}&hud=0&still=1&aa=none&grain=0&exposure=${EXPOSURE}&lookOutput=linear`;
const BOOT_MS = 150000;
const SETTLE_MS = 1200;

const chromeArgs = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,UseSkiaRenderer,WebGPUService',
  '--ignore-gpu-blocklist',
  '--disable-gpu-driver-bug-workarounds',
  '--use-angle=d3d11',
  '--enable-webgpu-developer-features',
  '--no-sandbox',
];

const failures = [];
const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

function frameStats(a, b) {
  let sumA = 0;
  let sumB = 0;
  let used = 0;
  let maxDiff = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const da = a.data[i + c] / 255;
      const db = b.data[i + c] / 255;
      maxDiff = Math.max(maxDiff, Math.abs(da - db));
      if (da < 0.02 || da > 0.85 || db > 0.9) continue;
      sumA += srgbToLinear(da);
      sumB += srgbToLinear(db);
      used++;
    }
  }
  return { ratio: used ? sumB / sumA : NaN, used, maxDiff };
}

async function shoot(page, path) {
  await page.waitForTimeout(SETTLE_MS);
  return PNG.sync.read(await page.locator('canvas').screenshot({ path }));
}

function expect(name, condition, detail) {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(name);
}

mkdirSync('shots/look', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: chromeArgs });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const ready = await page.waitForFunction(() => {
    const error = document.querySelector('#error-overlay');
    if (error && !error.hidden && !error.classList.contains('hidden')) return { error: document.querySelector('#error-message')?.textContent ?? 'error overlay' };
    const loading = document.querySelector('#loading-overlay');
    const hidden = !loading || loading.hidden || loading.classList.contains('hidden');
    return hidden && document.querySelector('canvas') && window.__fog ? { ready: true } : false;
  }, null, { timeout: BOOT_MS, polling: 500 }).then((handle) => handle.jsonValue());
  if (ready.error) throw new Error(`pipeline error: ${ready.error}`);

  const bootErrors = errors.length;
  const state = await page.evaluate(() => window.__fog.lookApply());
  expect('look state starts neutral', await page.evaluate(() => window.__fog.lookNeutral()), JSON.stringify(state));

  const noiseA = await shoot(page, 'shots/look/noise-a.png');
  const noiseB = await shoot(page, 'shots/look/noise-b.png');
  const noiseFloor = frameStats(noiseA, noiseB).maxDiff;
  console.log(`     frame-to-frame noise floor ${(noiseFloor * 255).toFixed(2)}/255`);

  const withLook = await shoot(page, 'shots/look/neutral-on.png');
  await page.evaluate(() => window.__fog.lookEnabled(false));
  const withoutLook = await shoot(page, 'shots/look/neutral-off.png');
  await page.evaluate(() => window.__fog.lookEnabled(true));
  const neutral = frameStats(withLook, withoutLook);
  expect('neutral look is the same frame as no look', neutral.maxDiff <= Math.max(2 / 255, noiseFloor), `max channel diff ${(neutral.maxDiff * 255).toFixed(2)}/255 against a noise floor of ${(noiseFloor * 255).toFixed(2)}/255`);

  const base = await shoot(page, 'shots/look/exposure-0ev.png');
  await page.evaluate(() => window.__fog.lookApply({ exposureEV: 1 }));
  const lifted = await shoot(page, 'shots/look/exposure-1ev.png');
  const exposure = frameStats(base, lifted);
  expect('+1 EV exposure compensation doubles the linear frame', Math.abs(exposure.ratio - 2) <= 0.05, `ratio ${exposure.ratio.toFixed(3)} over ${exposure.used} samples`);
  await page.evaluate(() => window.__fog.lookApply({ exposureEV: 0 }));

  await page.evaluate(() => window.__fog.split('baked', 0));
  const indirectBase = await shoot(page, 'shots/look/indirect-0ev.png');
  await page.evaluate(() => window.__fog.lookApply({ indirectEV: 1 }));
  const indirectLifted = await shoot(page, 'shots/look/indirect-1ev.png');
  const indirect = frameStats(indirectBase, indirectLifted);
  expect('+1 EV diffuse indirect doubles the baked term', Math.abs(indirect.ratio - 2) <= 0.08, `ratio ${indirect.ratio.toFixed(3)} over ${indirect.used} samples`);

  await page.evaluate(() => { window.__fog.lookApply({ indirectEV: 0 }); window.__fog.split('off', 0.5); });
  await page.evaluate(() => window.__fog.lookApply({ output: 'neutral', exposureEV: 0.5, indirectEV: 0.35, saturation: 1.06, contrast: 1.04 }));
  const working = await shoot(page, 'shots/look/working-look.png');
  await page.evaluate(() => window.__fog.lookApply({ exposureEV: 0, indirectEV: 0, saturation: 1, contrast: 1 }));
  const neutralAgain = await shoot(page, 'shots/look/working-neutral.png');
  const workingStats = frameStats(neutralAgain, working);
  expect('the first artistic probe visibly brightens the frame', workingStats.ratio > 1.2, `ratio ${workingStats.ratio.toFixed(3)}`);
  expect('sliders raised no new console errors', errors.length === bootErrors, errors.slice(bootErrors, bootErrors + 2).join(' | '));
} catch (error) {
  console.log(`FAIL ${error.message}`);
  failures.push(error.message);
} finally {
  await browser.close();
}

console.log(failures.length ? `FAILED: ${failures.join(', ')}` : 'OK look layer');
process.exit(failures.length ? 1 : 0);
