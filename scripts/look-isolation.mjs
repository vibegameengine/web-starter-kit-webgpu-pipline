import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { mkdirSync } from 'node:fs';

const SCENE = process.env.LOOK_SCENE ?? 'midsee-village';
const CAM = process.env.LOOK_CAM ?? 'front';
const URL = `http://127.0.0.1:5188/?scene=${SCENE}&cam=${CAM}&hud=0&still=1&grain=0`;
const BOOT_MS = 150000;
const SETTLE_MS = 1500;

const REGIONS = {
  'sunlit facade': [600, 200, 770, 300],
  'shadowed facade': [470, 250, 560, 340],
  'terrace stone': [760, 360, 940, 410],
  water: [380, 440, 900, 520],
  foliage: [330, 120, 520, 260],
  'studio backdrop': [0, 0, 220, 220],
};

const chromeArgs = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,UseSkiaRenderer,WebGPUService',
  '--ignore-gpu-blocklist',
  '--disable-gpu-driver-bug-workarounds',
  '--use-angle=d3d11',
  '--enable-webgpu-developer-features',
  '--no-sandbox',
];

const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

function medianLuminance(image, [x0, y0, x1, y1]) {
  const values = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      values.push(
        0.2126 * srgbToLinear(image.data[i] / 255)
        + 0.7152 * srgbToLinear(image.data[i + 1] / 255)
        + 0.0722 * srgbToLinear(image.data[i + 2] / 255),
      );
    }
  }
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

const rows = [];
async function record(page, label, path) {
  await page.waitForTimeout(SETTLE_MS);
  const image = PNG.sync.read(await page.screenshot({ path }));
  rows.push({ label, ...Object.fromEntries(Object.entries(REGIONS).map(([name, box]) => [name, medianLuminance(image, box)])) });
  return image;
}

mkdirSync('shots/look/isolation', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: chromeArgs });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

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

  const settled = await page.evaluate(async () => {
    let previous = await window.__fog.exposure();
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const current = await window.__fog.exposure();
      if (Math.abs(current - previous) <= previous * 0.002) return { exposure: current, attempts: attempt };
      previous = current;
    }
    return { exposure: previous, attempts: 40 };
  });
  console.log(`meter settled to ${settled.exposure.toFixed(4)} after ${settled.attempts} quarter-second polls`);

  const before = await page.evaluate(async () => ({
    exposure: await window.__fog.exposure(),
    settings: { ...window.__fog.exposureSettings },
    glare: window.__fog.glare(),
    sun: window.__audit?.lighting?.() ?? null,
  }));
  console.log(`metered E0 ${before.exposure.toFixed(4)}, auto ${before.settings.auto}, glare ${before.glare}`);
  console.log(`sun ${JSON.stringify(before.sun?.sun ?? before.sun)}`);

  await record(page, 'as shipped (auto exposure, glare on)', 'shots/look/isolation/00-baseline.png');

  await page.evaluate(() => window.__fog.glare(false));
  await record(page, 'glare off', 'shots/look/isolation/01-glare-off.png');

  const E0 = before.exposure;
  for (const [stops, factor] of [[0, 1], [0.5, Math.SQRT2], [1, 2]]) {
    await page.evaluate((manual) => { window.__fog.exposureSettings.auto = false; window.__fog.exposureSettings.manual = manual; }, E0 * factor);
    await record(page, `locked exposure ${stops === 0 ? 'E0' : `E0 +${stops} stop`}`, `shots/look/isolation/02-exposure-${stops}.png`);
  }

  await page.evaluate((manual) => { window.__fog.exposureSettings.manual = manual; }, E0);
  await page.evaluate(() => window.__fog.lookApply({ indirectEV: 0.35 }));
  await record(page, 'locked E0 + diffuse indirect +0.35 EV', 'shots/look/isolation/03-indirect.png');

  await page.evaluate(() => window.__fog.lookApply({ exposureEV: 0.5, saturation: 1.06, contrast: 1.04 }));
  await record(page, 'first artistic probe (+0.5 EV, indirect +0.35 EV, sat 1.06, contrast 1.04)', 'shots/look/isolation/04-look.png');

  await page.evaluate(() => window.__fog.glare(true));
  await record(page, 'probe with the scene glare back on', 'shots/look/isolation/05-look-glare.png');

  await page.evaluate((settings) => Object.assign(window.__fog.exposureSettings, settings), before.settings);
  await page.evaluate(() => window.__fog.lookApply({ exposureEV: 0, indirectEV: 0, saturation: 1, contrast: 1 }));
  await record(page, 'restored: original exposure profile, neutral look', 'shots/look/isolation/06-restored.png');
} catch (error) {
  console.log(`FAIL ${error.message}`);
} finally {
  await browser.close();
}

const names = Object.keys(REGIONS);
console.log(`\n${'step'.padEnd(62)}${names.map((n) => n.slice(0, 15).padStart(17)).join('')}`);
for (const row of rows) console.log(`${row.label.padEnd(62)}${names.map((n) => row[n].toFixed(4).padStart(17)).join('')}`);
if (errors.length) console.log(`\npage errors: ${errors.slice(0, 3).join(' | ')}`);
