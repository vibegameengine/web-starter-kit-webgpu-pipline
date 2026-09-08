// Which pass leaves the dark speckle along the Cornell seams? One capture per
// suspect, same camera, same settle time; the metric counts pixels much darker than
// their own neighbourhood inside two seam strips. Headed, gate 3 minutes.
//
//   node scripts/_corner_dots.mjs [settleFrames]
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { mkdir, writeFile } from 'node:fs/promises';

setTimeout(() => { console.error('gate: 3 minutes, abort'); process.exit(2); }, 180000);
await mkdir('shots/corner-dots', { recursive: true });
const settle = Number(process.argv[2] ?? 90);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const luma = (img, x, y) => { const p = (y * img.width + x) * 4; return 0.2126 * img.data[p] + 0.7152 * img.data[p + 1] + 0.0722 * img.data[p + 2]; };

/** Pixels below 70% of the median of their own 9x9 neighbourhood: speckle, not shading. */
const speckle = (img, [rx, ry, rw, rh]) => {
  let dots = 0, total = 0;
  for (let y = ry + 4; y < ry + rh - 4; y++) {
    for (let x = rx + 4; x < rx + rw - 4; x++) {
      const around = [];
      for (let j = -4; j <= 4; j += 2) for (let i = -4; i <= 4; i += 2) if (i || j) around.push(luma(img, x + i, y + j));
      around.sort((a, b) => a - b);
      const median = around[around.length >> 1];
      if (median > 20 && luma(img, x, y) < median * 0.7) dots++;
      total++;
    }
  }
  return { dots, percent: +(100 * dots / total).toFixed(2) };
};

const configs = [
  ['default', ''],
  ['contact off', '&contact=0'],
  ['reflections off', '&reflections=0'],
  ['both off', '&contact=0&reflections=0'],
  ['every frame again', '&contactEvery=1&reflectionsEvery=1'],
  ['no TAA', '&aa=none'],
];
// Left wall/floor seam and the right wall/floor seam of the Cornell frame at 1600x900.
const seams = { left: [330, 560, 300, 220], right: [960, 560, 320, 200] };
for (const [name, query] of configs) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`http://127.0.0.1:5188/?hud=0&grain=0&exposure=1${query}`);
  await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 120000 });
  await page.evaluate((frames) => new Promise((resolve) => {
    let seen = 0;
    const f = () => { seen += 1; if (seen >= frames) resolve(); else requestAnimationFrame(f); };
    requestAnimationFrame(f);
  }), settle);
  const png = await page.screenshot();
  await writeFile(`shots/corner-dots/${name.replace(/ /g, '-')}.png`, png);
  const img = PNG.sync.read(png);
  await page.close();
  console.log(`${name.padEnd(18)} left seam ${String(speckle(img, seams.left).percent).padStart(5)}%   right seam ${String(speckle(img, seams.right).percent).padStart(5)}%`);
}
await browser.close();
