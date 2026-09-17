import { chromium } from 'playwright';

const port = process.env.PORT ?? '5188';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/?scene=sky&hud=0&bakeCache=0&clouds=0&aerial=0&sunAz=-60&sunEl=${process.env.SUN_EL ?? 45}&${process.env.QUERY ?? ''}`);
const ok = await page.waitForFunction(() => window.__sky && window.__audit && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 150000 }).then(() => true).catch(() => false);
if (!ok) { console.log('boot fail', errors.slice(0, 3)); await browser.close(); process.exit(1); }
await page.evaluate(() => window.__camera(0, 12, 0.01, 0, 0, 0));
await page.waitForTimeout(3000);
const result = await page.evaluate(async (bakedOnly) => {
  const tex = window.__sky.environmentTexture();
  const { data, width, height } = tex.image;
  const fromHalf = (h) => { const e = (h & 0x7c00) >> 10, f = h & 0x03ff; if (e === 0) return 2 ** -14 * (f / 1024); return 2 ** (e - 15) * (1 + f / 1024); };
  const irradiance = [0, 0, 0];
  const dTheta = Math.PI / height, dPhi = (2 * Math.PI) / width;
  for (let y = 0; y < height / 2; y++) {
    const elevation = Math.PI / 2 - (y + 0.5) * dTheta;
    const weight = Math.sin(elevation) * Math.cos(elevation) * dTheta * dPhi;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) irradiance[c] += fromHalf(data[i + c]) * weight;
    }
  }
  if (bakedOnly) window.__bakedOnly(true);
  await new Promise((r) => setTimeout(r, 2500));
  window.__audit.pause(true);
  const frame = await window.__audit.read();
  window.__audit.pause(false);
  const bytes = Uint8Array.from(atob(frame.base.data), (ch) => ch.charCodeAt(0));
  const floats = new Float32Array(bytes.buffer);
  const w = frame.base.width, h = frame.base.height;
  const sample = (fx, fy) => {
    const acc = [0, 0, 0]; let n = 0;
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const x = Math.floor(fx * w) + dx, y = Math.floor(fy * h) + dy, i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) acc[c] += floats[i + c]; n++;
    }
    return acc.map((v) => +(v / n).toFixed(4));
  };
  return { irradiance: irradiance.map((v) => +v.toFixed(3)), sunLight: window.__sky.sunLight(), sunIntensity: window.__probe().sunIntensity, points: { a: sample(0.2, 0.85), b: sample(0.5, 0.92), c: sample(0.85, 0.85), d: sample(0.12, 0.5) } };
}, process.env.BAKED_ONLY === '1');
console.log(JSON.stringify(result));
await page.screenshot({ path: `shots/shade/${process.env.TAG ?? 'frame'}.png` });
await browser.close();
