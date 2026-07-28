// Headless screenshot tool — the enforcement arm of "verify visually".
// Usage: node scripts/capture.mjs [outfile.png] [--url http://127.0.0.1:5188] [--wait 3500] [--w 1600] [--h 900]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const out = resolve(positional[0] ?? 'shots/scene.png');
const url = flag('url', 'http://127.0.0.1:5188');
const wait = Number(flag('wait', '4000'));
const width = Number(flag('w', '1600'));
const height = Number(flag('h', '900'));

mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=d3d11',
    '--enable-unsafe-swiftshader',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--enable-gpu-rasterization',
  ],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e && e.stack ? e.stack : e)));

console.log(`→ loading ${url}`);
await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => {
  console.error('navigation failed:', e.message);
});
await page.waitForTimeout(wait);

const hasCanvas = await page.evaluate(() => !!document.querySelector('canvas'));
const perf = await page.evaluate(() => (window.__perf ? { ...window.__perf } : null));

// Clean frame: hide dev overlays (stats panel, boot text) before the shot.
await page.addStyleTag({ content: '#stats,#boot{display:none!important}' }).catch(() => {});

// Screenshot to a buffer, then decode the actual PNG pixels in-page (reliable
// for WebGL canvases that don't preserve their drawing buffer for readPixels).
const buf = await page.screenshot({ path: out });
const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
const stats = await page.evaluate(async (url) => {
  const img = new Image();
  img.src = url;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const g = cv.getContext('2d');
  g.drawImage(img, 0, 0);
  const step = 41;
  let n = 0, sum = 0, sum2 = 0, distinct = new Set();
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const d = g.getImageData(x, y, 1, 1).data;
      const lum = (d[0] * 0.299 + d[1] * 0.587 + d[2] * 0.114) | 0;
      n++; sum += lum; sum2 += lum * lum;
      distinct.add(`${d[0] >> 4},${d[1] >> 4},${d[2] >> 4}`);
    }
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  return { w: img.width, h: img.height, mean: +mean.toFixed(1), std: +std.toFixed(1), distinct: distinct.size };
}, dataUrl);

await browser.close();

console.log(`✓ saved ${out}`);
console.log(`  image: ${JSON.stringify(stats)}`);
if (perf) console.log(`  perf : ${JSON.stringify(perf)}`);
if (errors.length) {
  console.log(`  ⚠ ${errors.length} console error(s):`);
  errors.slice(0, 8).forEach((e) => console.log('   -', e));
}
// Blank = no canvas, or a nearly-uniform frame (few distinct colours + low std).
const blank = !hasCanvas || (stats.distinct < 6 && stats.std < 4);
if (blank) { console.error('✗ BLANK/UNIFORM FRAME — verification FAILED'); process.exit(2); }
if (errors.length) { console.error('✗ console errors present'); process.exit(3); }
