import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { bootOrFail } from './_harness.mjs';

const port = process.env.PORT ?? '5188';
const base = process.env.QUERY ?? 'scene=village-light&grain=0&aa=none&hud=0';
const out = process.env.OUT ?? 'shots/vt-flight';
const variants = JSON.parse(process.env.VARIANTS ?? '[["atlas","&lod=0"],["small","&vtPool=4"]]');
const timer = setTimeout(() => { console.error('gate'); process.exit(2); }, 420000);
mkdirSync(out, { recursive: true });
const poses = [
  [14, 6, 14, 0, 2, 0], [6, 3, 9, 0, 2, 0], [2, 2, 6, 0, 2, -2], [-6, 3, 8, 0, 2, 0], [-10, 8, -6, 0, 2, 0], [8, 1.7, -2, 0, 1.5, -6], [20, 12, 20, 0, 2, 0],
];
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (error) => { console.error('pageerror:', String(error).slice(0, 300)); process.exit(3); });
const frames = (count) => page.evaluate((n) => new Promise((resolve) => { let i = 0; const tick = () => (++i > n ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }), count);
const shots = {};
for (const [name, extra] of variants) {
  await page.goto(`http://127.0.0.1:${port}/?${base}${extra}`);
  await bootOrFail(page, 240000);
  await frames(300);
  await page.evaluate(() => window.__bakedOnly?.(true));
  shots[name] = [];
  for (const [index, pose] of poses.entries()) {
    await page.evaluate((p) => window.__camera(...p), pose);
    await frames(Number(process.env.SETTLE ?? 90));
    const path = `${out}/${name}-${index}.png`;
    await page.screenshot({ path });
    shots[name].push(path);
    const lod = await page.evaluate(() => { const r = window.__lod?.(); return r && { resident: r.resident, slots: r.slots, asked: r.asked, planned: r.planned, coarsened: r.coarsened, refused: r.refused }; });
    console.log(name, index, JSON.stringify(lod));
  }
}
const [reference, ...others] = variants.map(([name]) => name);
for (const other of others) {
  for (let index = 0; index < poses.length; index++) {
    const a = PNG.sync.read((await import('node:fs')).readFileSync(shots[reference][index]));
    const b = PNG.sync.read((await import('node:fs')).readFileSync(shots[other][index]));
    let big = 0, darker = 0;
    const diff = new PNG({ width: a.width, height: a.height });
    for (let i = 0; i < a.data.length; i += 4) {
      const la = 0.2126 * a.data[i] + 0.7152 * a.data[i + 1] + 0.0722 * a.data[i + 2];
      const lb = 0.2126 * b.data[i] + 0.7152 * b.data[i + 1] + 0.0722 * b.data[i + 2];
      if (Math.abs(la - lb) > 24) big++;
      if (la > 24 && lb < la * 0.25) darker++;
      const g = Math.min(255, Math.abs(la - lb) * 6);
      diff.data[i] = g; diff.data[i + 1] = g; diff.data[i + 2] = g; diff.data[i + 3] = 255;
    }
    writeFileSync(`${out}/diff-${other}-${index}.png`, PNG.sync.write(diff));
    console.log(`${other} pose ${index}: pixels off by >24/255 ${big}, lit pixels gone dark ${darker}`);
  }
}
clearTimeout(timer);
await browser.close();
