// Two consecutive frames with the wind blowing, headed, for the user to compare.
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import fs from 'node:fs';
const q = process.argv[2] ?? '';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&cam=leaves${q}`);
await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
await page.waitForTimeout(4000);
const frames = [];
for (let i = 0; i < 3; i++) { frames.push(PNG.sync.read(await page.screenshot({ path: `shots/taa/wind-${i}.png` }))); await page.waitForTimeout(60); }
const diff = (x, y) => { let s = 0, n = 0; for (let i = 0; i < x.data.length; i += 4) { for (let k = 0; k < 3; k++) s += Math.abs(x.data[i + k] - y.data[i + k]); n += 3; } return (s / n).toFixed(2); };
console.log('wind frames diff 0-1', diff(frames[0], frames[1]), '1-2', diff(frames[1], frames[2]), '0-2', diff(frames[0], frames[2]));
// crop of the crown at 2x for the eye: frames 0 and 1 side by side
const x0 = 500, y0 = 60, w = 400, h = 225, S = 2; const out = new PNG({ width: w * S * 2, height: h * S });
[frames[0], frames[1]].forEach((img, k) => { for (let y = 0; y < h * S; y++) for (let x = 0; x < w * S; x++) { const si = ((y0 + Math.floor(y / S)) * img.width + x0 + Math.floor(x / S)) * 4, di = (y * out.width + k * w * S + x) * 4; for (let c = 0; c < 4; c++) out.data[di + c] = img.data[si + c]; } });
fs.writeFileSync('shots/taa/wind-consecutive.png', PNG.sync.write(out));
await browser.close();
