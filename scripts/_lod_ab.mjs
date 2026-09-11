import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';

const out = 'shots/lod';
await mkdir(out, { recursive: true });
const cam = process.env.LOD_CAM ?? 'bench';
const cases = [
  { tag: 'resident', query: `?scene=corridor&cam=${cam}&lod=0&still=1&freezeAt=0` },
  { tag: 'lod1024', query: `?scene=corridor&cam=${cam}&lod=1&lodAtlas=1024&still=1&freezeAt=0` },
  { tag: 'lod512', query: `?scene=corridor&cam=${cam}&lod=1&lodAtlas=512&still=1&freezeAt=0` },
  { tag: 'lod128', query: `?scene=corridor&cam=${cam}&lod=1&lodAtlas=128&still=1&freezeAt=0` },
  { tag: 'resident2', query: `?scene=corridor&cam=${cam}&lod=0&still=1&freezeAt=0` },
];
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const shots = {};
const stats = {};
try {
  for (const item of cases) {
    const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
    await page.goto(`http://127.0.0.1:5188/${item.query}`);
    await bootOrFail(page);
    await page.addStyleTag({ content: '.lil-gui, #hud { display: none !important; }' });
    await page.evaluate(() => window.__audit?.hideOverlay?.());
    await page.evaluate(() => window.__audit.sun(-116.5, 53.2, 12.13));
    await page.waitForTimeout(3500);
    const buffer = await page.screenshot({ path: `${out}/ab-${item.tag}.png` });
    shots[item.tag] = PNG.sync.read(buffer);
    stats[item.tag] = await page.evaluate(() => window.__lod?.() ?? null);
    await page.close();
  }
} finally { await browser.close(); }

const diff = (a, b) => {
  let sum = 0;
  let worst = 0;
  let over8 = 0;
  let over24 = 0;
  const pixels = a.data.length / 4;
  for (let i = 0; i < a.data.length; i += 4) {
    let channelWorst = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i + c] - b.data[i + c]);
      sum += d;
      if (d > channelWorst) channelWorst = d;
    }
    if (channelWorst > worst) worst = channelWorst;
    if (channelWorst > 8) over8++;
    if (channelWorst > 24) over24++;
  }
  return {
    mean: +(sum / (pixels * 3)).toFixed(3), worst,
    over8: +(100 * over8 / pixels).toFixed(2) + '%',
    over24: +(100 * over24 / pixels).toFixed(2) + '%',
  };
};
const report = {
  'noise floor (resident vs resident)': diff(shots.resident2, shots.resident),
  'lod1024 vs resident': diff(shots.lod1024, shots.resident),
  'lod512 vs resident': diff(shots.lod512, shots.resident),
  'lod128 vs resident (must fail)': diff(shots.lod128, shots.resident),
  lod1024: stats.lod1024, lod512: stats.lod512, lod128: stats.lod128,
};
await writeFile(`${out}/ab.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
