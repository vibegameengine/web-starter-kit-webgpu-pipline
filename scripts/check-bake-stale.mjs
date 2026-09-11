import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';

const FRESH_SCENE = process.env.STALE_SCENE ?? 'corridor';
const FRESH_CAM = process.env.STALE_CAM ?? 'hero';
const LEGACY_SCENE = process.env.STALE_LEGACY_SCENE ?? 'midsee-village';
const LEGACY_CAM = process.env.STALE_LEGACY_CAM ?? 'front';
const BAKES = 'public/bakes';
const BOOT_MS = 240000;

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
const expect = (name, condition, detail) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(name);
};

const keyOf = (scene) => createHash('sha256').update(`bake:${scene}`).digest('hex');

function dropBake(scene) {
  const key = keyOf(scene);
  if (!existsSync(BAKES)) return key;
  for (const name of readdirSync(BAKES)) if (name.startsWith(key)) rmSync(`${BAKES}/${name}`);
  return key;
}

async function boot(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const ready = await page.waitForFunction(() => {
    const error = document.querySelector('#error-overlay');
    if (error && !error.hidden && !error.classList.contains('hidden')) return { error: document.querySelector('#error-message')?.textContent ?? 'error overlay' };
    const loading = document.querySelector('#loading-overlay');
    const hidden = !loading || loading.hidden || loading.classList.contains('hidden');
    return hidden && document.querySelector('canvas') && window.__audit && window.__probe ? { ready: true } : false;
  }, null, { timeout: BOOT_MS, polling: 500 }).then((handle) => handle.jsonValue());
  if (ready.error) throw new Error(`pipeline error: ${ready.error}`);
  await page.waitForTimeout(1500);
}

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: chromeArgs });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (error) => { console.log(`FAIL page error: ${error}`); failures.push('page error'); });

try {
  const key = dropBake(FRESH_SCENE);
  await boot(page, `http://127.0.0.1:5188/?scene=${FRESH_SCENE}&cam=${FRESH_CAM}&still=1`);

  const fresh = await page.evaluate(() => ({ status: window.__audit.bakeStatus(), cache: window.__audit.bakeCache() }));
  expect('a fresh bake is valid against the light it was baked under', fresh.status.state === 'valid', `${fresh.status.state} ${fresh.status.reasons.join('; ')} (source ${fresh.cache.source})`);

  const binary = `${BAKES}/${key}.bin`;
  const writtenAt = existsSync(binary) ? statSync(binary).mtimeMs : 0;
  expect('the fresh bake was saved with its provenance', writtenAt > 0 && existsSync(`${BAKES}/${key}.json`));

  const before = await page.evaluate(() => window.__probe().lightCfg);
  const moved = await page.evaluate((cfg) => window.__audit.sun(cfg.azimuthDeg + 10, cfg.elevationDeg), before);
  await page.waitForTimeout(600);
  const afterMove = await page.evaluate(() => ({ status: window.__audit.bakeStatus(), cache: window.__audit.bakeCache() }));
  expect('moving the sun marks the baked indirect stale', afterMove.status.state === 'stale' && afterMove.status.reasons.some((reason) => reason.includes('sun moved')), `${afterMove.status.state}: ${afterMove.status.reasons.join('; ')} (sun now ${moved[0].toFixed(2)}/${moved[1].toFixed(2)})`);

  const dimmed = await page.evaluate((cfg) => window.__audit.sun(cfg.azimuthDeg + 10, cfg.elevationDeg, cfg.intensity * 1.5), before);
  await page.waitForTimeout(300);
  const afterDim = await page.evaluate(() => window.__audit.bakeStatus());
  expect('changing sun intensity is a separate reason', afterDim.reasons.some((reason) => reason.includes('sun intensity')), `${afterDim.reasons.join('; ')} (intensity ${dimmed[2].toFixed(3)})`);

  expect('nothing rebaked or rewrote the bake behind the person', statSync(binary).mtimeMs === writtenAt, `mtime ${statSync(binary).mtimeMs} against ${writtenAt}`);

  await page.evaluate((cfg) => window.__audit.sun(cfg.azimuthDeg, cfg.elevationDeg, cfg.intensity), before);
  await page.waitForTimeout(600);
  const restored = await page.evaluate(() => window.__audit.bakeStatus());
  expect('putting the sun back makes it valid again', restored.state === 'valid', `${restored.state}: ${restored.reasons.join('; ')}`);

  const hudText = await page.evaluate(() => document.querySelector('[data-testid="hud-baked-light"]')?.textContent ?? '');
  expect('the HUD shows the baked-light status', hudText.length > 0, `"${hudText}"`);

  await boot(page, `http://127.0.0.1:5188/?scene=${LEGACY_SCENE}&cam=${LEGACY_CAM}&still=1`);
  const legacy = await page.evaluate(() => ({ status: window.__audit.bakeStatus(), cache: window.__audit.bakeCache() }));
  const legacyExpected = legacy.cache.source === 'saved' ? 'unknown' : 'valid';
  expect(`a bake saved before provenance existed reports "${legacyExpected}"`, legacy.status.state === legacyExpected, `${legacy.status.state}: ${legacy.status.reasons.join('; ')} (source ${legacy.cache.source})`);
} catch (error) {
  console.log(`FAIL ${error.message}`);
  failures.push(error.message);
} finally {
  await browser.close();
}

console.log(failures.length ? `FAILED: ${failures.join(', ')}` : 'OK bake provenance');
process.exit(failures.length ? 1 : 0);
