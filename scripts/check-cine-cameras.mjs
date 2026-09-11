import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const SCENE = process.env.CINE_SCENE ?? 'midsee-village';
const CAM = process.env.CINE_CAM ?? 'front';
const PRESETS = ['alexa35-32', 'alexa-lf-40', 'venice2-24', 'raptor-50', 'anamorphic-2x-40', 'imax65-50'];
const BOOT_MS = 300000;

const SENSORS = {
  'alexa35-32': { width: 27.99, focal: 32, squeeze: 1 },
  'alexa-lf-40': { width: 36.70, focal: 40, squeeze: 1 },
  'venice2-24': { width: 35.9, focal: 24, squeeze: 1 },
  'raptor-50': { width: 40.96, focal: 50, squeeze: 1 },
  'anamorphic-2x-40': { width: 31.68, focal: 40, squeeze: 2 },
  'imax65-50': { width: 70.41, focal: 50, squeeze: 1 },
};

const chromeArgs = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--no-sandbox'];
const failures = [];
const expect = (name, condition, detail) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(name);
};

mkdirSync('shots/look/cine', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: chromeArgs });
const rows = [];

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:5188/?scene=${SCENE}&cam=${CAM}&hud=0&still=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const ready = await page.waitForFunction(() => {
    const error = document.querySelector('#error-overlay');
    if (error && !error.hidden && !error.classList.contains('hidden')) return { error: document.querySelector('#error-message')?.textContent ?? 'error overlay' };
    const loading = document.querySelector('#loading-overlay');
    return (!loading || loading.hidden || loading.classList.contains('hidden')) && window.__cine ? { ready: true } : false;
  }, null, { timeout: BOOT_MS, polling: 500 }).then((handle) => handle.jsonValue());
  if (ready.error) throw new Error(`pipeline error: ${ready.error}`);
  await page.waitForTimeout(1200);
  const bootErrors = errors.length;

  for (const preset of PRESETS) {
    const measured = await page.evaluate((name) => window.__cine(name), preset);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `shots/look/cine/${preset}.png` });
    rows.push({ preset, label: measured.label, horizontalFov: measured.horizontalFovDeg, verticalFov: measured.verticalFovDeg, shutter: +measured.shutter.toFixed(3), stops: measured.stops });
    expect(`${preset}: the projection follows the sensor and the lens`, Math.abs(measured.horizontalFovDeg - 2 * Math.atan((SENSORS[preset].width * SENSORS[preset].squeeze) / (2 * SENSORS[preset].focal)) * 180 / Math.PI) < 0.05, `${measured.horizontalFovDeg}° horizontal, ${measured.verticalFovDeg}° vertical`);
  }
  expect('switching cameras raised no page errors', errors.length === bootErrors, errors.slice(bootErrors, bootErrors + 2).join(' | '));
  await page.close();

  const byPreset = Object.fromEntries(rows.map((row) => [row.preset, row]));
  expect('a longer lens on the same body frames tighter', byPreset['alexa35-32'].horizontalFov > byPreset['raptor-50'].horizontalFov, `32 mm ${byPreset['alexa35-32'].horizontalFov}° against 50 mm ${byPreset['raptor-50'].horizontalFov}°`);
  expect('large format sees wider than vista vision at a shorter focal length', byPreset['alexa-lf-40'].horizontalFov > byPreset['raptor-50'].horizontalFov, `LF 40 mm ${byPreset['alexa-lf-40'].horizontalFov}° against VV 50 mm ${byPreset['raptor-50'].horizontalFov}°`);
  expect('the 2x squeeze widens the frame against the same lens on a bigger gate', byPreset['anamorphic-2x-40'].horizontalFov > byPreset['alexa-lf-40'].horizontalFov, `anamorphic 40 mm ${byPreset['anamorphic-2x-40'].horizontalFov}° against LF 40 mm ${byPreset['alexa-lf-40'].horizontalFov}°`);
  expect('the same 50 mm sees far wider on a 65 mm gate than on vista vision', byPreset['imax65-50'].horizontalFov > byPreset['raptor-50'].horizontalFov * 1.4, `IMAX 65 ${byPreset['imax65-50'].horizontalFov}° against VV ${byPreset['raptor-50'].horizontalFov}° at the same focal length`);
  expect('VENICE carries its 172.8° shutter into the motion blur', Math.abs(byPreset['venice2-24'].shutter - 172.8 / 360) < 0.002, `${byPreset['venice2-24'].shutter}`);
  expect('the 180° cameras carry a half-open shutter', Math.abs(byPreset['alexa35-32'].shutter - 0.5) < 0.002, `${byPreset['alexa35-32'].shutter}`);
  console.table(rows);
} catch (error) {
  console.log(`FAIL ${error.message}`);
  failures.push(error.message);
} finally {
  await browser.close();
}

console.log(failures.length ? `FAILED: ${failures.join(', ')}` : 'OK cine cameras');
process.exit(failures.length ? 1 : 0);
