import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';

const port = process.env.PORT ?? '5188';
const query = process.env.QUERY ?? 'scene=village-light&cam=hero';
const points = (process.env.POINTS ?? '-0.2,0.1 0,0 0.2,-0.1').split(' ').map((p) => p.split(',').map(Number));
const gate = Number(process.env.GATE_MS ?? 280000);
const timer = setTimeout(() => { console.error('gate'); process.exit(2); }, gate);

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (error) => console.error('pageerror:', String(error).slice(0, 200)));
await page.goto(`http://127.0.0.1:${port}/?${query}&leak=1&hud=0`);
await bootOrFail(page, gate - 40000);
await page.waitForTimeout(1500);

for (const [ndcX, ndcY] of points) {
  const report = await page.evaluate(([x, y]) => {
    const hit = window.__audit?.pick(x, y);
    if (!hit) return { hit: null };
    const texel = window.__leak?.atWorld(hit.point[0], hit.point[1], hit.point[2], 0.2);
    return { hit, texel };
  }, [ndcX, ndcY]);
  if (!report.hit) { console.log(`${ndcX},${ndcY}: nothing under the cursor`); continue; }
  const { name, point, normal } = report.hit;
  console.log(`${ndcX},${ndcY} -> ${name} at ${point.join(',')} normal ${normal?.join(',') ?? '-'}`);
  console.log('   ', JSON.stringify(report.texel)?.slice(0, 600) ?? 'no texel within 0.2 m');
}
clearTimeout(timer);
await browser.close();
