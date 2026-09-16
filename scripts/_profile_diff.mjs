import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';

const port = process.env.PORT ?? '5188';
const query = process.env.QUERY ?? 'scene=midsee-village&hud=1';
const onAction = process.env.ON ?? 'window.__shadowAutoUpdate(true)';
const offAction = process.env.OFF ?? 'window.__shadowAutoUpdate(false)';
const timer = setTimeout(() => { console.error('gate'); process.exit(2); }, 240000);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (error) => { console.error('pageerror:', String(error).slice(0, 300)); process.exit(3); });
await page.goto(`http://127.0.0.1:${port}/?${query}`);
await bootOrFail(page, 200000);
const frames = (n) => page.evaluate((count) => new Promise((resolve) => { let i = 0; const tick = () => (++i > count ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }), n);
await frames(400);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });

async function profile(action) {
  await page.evaluate(action);
  await frames(60);
  await cdp.send('Profiler.start');
  await frames(200);
  const { profile: data } = await cdp.send('Profiler.stop');
  const nodes = new Map(data.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of data.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const label = (id) => { const f = nodes.get(id).callFrame; return `${f.functionName || '(anon)'} ${f.url.split('?')[0].split('/').slice(-1)[0] || 'native'}:${f.lineNumber}`; };
  const self = new Map();
  const total = new Map();
  for (let i = 0; i < data.samples.length; i++) {
    const ms = (data.timeDeltas[i] ?? 0) / 1000;
    const leaf = label(data.samples[i]);
    self.set(leaf, (self.get(leaf) ?? 0) + ms);
    const seen = new Set();
    for (let id = data.samples[i]; id !== undefined; id = parent.get(id)) {
      const name = label(id);
      if (seen.has(name)) continue;
      seen.add(name);
      total.set(name, (total.get(name) ?? 0) + ms);
    }
  }
  return { self, total };
}

const on = await profile(onAction);
const off = await profile(offAction);
const diff = (a, b) => [...new Set([...a.keys(), ...b.keys()])].map((k) => [k, ((a.get(k) ?? 0) - (b.get(k) ?? 0)) / 200]).sort((x, y) => y[1] - x[1]);
console.log('--- total ms/frame, ON minus OFF');
for (const [k, v] of diff(on.total, off.total).slice(0, 30)) console.log(v.toFixed(3).padStart(7), k);
console.log('--- self ms/frame, ON minus OFF');
for (const [k, v] of diff(on.self, off.self).slice(0, 20)) console.log(v.toFixed(3).padStart(7), k);
clearTimeout(timer);
await browser.close();
