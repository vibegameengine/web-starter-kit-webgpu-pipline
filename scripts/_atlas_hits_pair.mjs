// Does reading the atlas at static hits change the picture? Same frozen pose, two
// runs, mean |luma| difference plus a run-to-run drift baseline. Headed, gate 3 min.
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { mkdir, writeFile } from 'node:fs/promises';
setTimeout(() => { console.error('gate: 3 minutes, abort'); process.exit(2); }, 180000);
await mkdir('shots/atlas-hits', { recursive: true });
const scene = process.argv[2] ?? '';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const luma = (i, d) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
const diff = (a, b) => { let s = 0, n = 0; for (let i = 0; i < a.data.length; i += 4) { s += Math.abs(luma(i, a.data) - luma(i, b.data)); n++; } return s / n; };
const shot = async (query, name) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`http://127.0.0.1:5188/?hud=0&freezeAt=0&still=1&grain=0&exposure=1${scene}${query}`);
  await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 120000 });
  await page.evaluate(() => new Promise((r) => { let n = 0; const f = () => { n += 1; if (n >= 90) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
  const png = await page.screenshot(); await writeFile(`shots/atlas-hits/${name}.png`, png); await page.close();
  return PNG.sync.read(png);
};
const off1 = await shot('&atlasHits=0', 'cache-1');
const off2 = await shot('&atlasHits=0', 'cache-2');
const on = await shot('', 'atlas');
console.log(`atlas vs cache ${diff(on, off1).toFixed(2)}/255, run-to-run drift of the cache path ${diff(off1, off2).toFixed(2)}/255`);
await browser.close();
