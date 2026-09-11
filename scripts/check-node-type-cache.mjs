import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const GATE_MS = Number(process.env.GATE_MS ?? 420000);
const gate = setTimeout(() => { console.error(`gate: ${GATE_MS / 1000}s, abort`); process.exit(2); }, GATE_MS);
const port = process.env.PORT ?? '5188';
const scene = process.env.SCENE ?? 'midsee-village';
const url = `http://127.0.0.1:${port}/?scene=${scene}&hud=0&cam=front&still=1&grain=0&aa=none${process.env.EXTRA ?? ''}`;
mkdirSync('shots/node-type-cache', { recursive: true });

async function boot(cacheOff) {
  const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  let failure = null;
  page.on('pageerror', (error) => { failure ??= error.message; });
  await page.addInitScript((off) => {
    if (off) globalThis.__nodeTypeCacheOff = true;
    window.__t = { shaders: null, first: null };
    const watch = () => {
      const message = document.querySelector('#loading-message');
      if (!message) { requestAnimationFrame(watch); return; }
      new MutationObserver(() => {
        const text = message.textContent ?? '';
        if (text.includes('Compiling shaders')) window.__t.shaders = performance.now();
        if (text.includes('Waiting for the first frame')) window.__t.first = performance.now();
      }).observe(message, { childList: true, characterData: true, subtree: true });
    };
    watch();
  }, cacheOff);
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#loading-overlay')?.hidden, null, { timeout: GATE_MS / 2, polling: 300 });
  const t = await page.evaluate(() => ({ ...window.__t, done: performance.now() }));
  await page.waitForTimeout(20000);
  await page.waitForFunction(() => {
    const read = window.__fog?.exposure;
    if (typeof read !== 'function') return true;
    const now = read();
    const previous = window.__exposureSeen;
    window.__exposureSeen = now;
    return previous !== undefined && Math.abs(now - previous) < 2e-3 * Math.abs(now);
  }, null, { timeout: 90000, polling: 2000 }).catch(() => {});
  const exposure = await page.evaluate(() => window.__fog?.exposure?.() ?? null);
  const shot = await page.screenshot();
  await browser.close();
  if (failure) throw new Error(`page error with cacheOff=${cacheOff}: ${failure}`);
  return { shaders: (t.first - t.shaders) / 1000, firstFrame: (t.done - t.first) / 1000, shot, exposure };
}

const off = await boot(process.env.CONTROL === '1' ? false : true);
const on = await boot(false);
writeFileSync('shots/node-type-cache/cache-off.png', off.shot);
writeFileSync('shots/node-type-cache/cache-on.png', on.shot);
const a = PNG.sync.read(off.shot), b = PNG.sync.read(on.shot);
const meanOf = (png) => { let sum = 0; for (let i = 0; i < png.data.length; i += 4) sum += png.data[i] + png.data[i + 1] + png.data[i + 2]; return sum / (png.data.length / 4 * 3); };
const gain = meanOf(a) / meanOf(b);
let differing = 0, worst = 0, differingScaled = 0, worstScaled = 0;
for (let i = 0; i < a.data.length; i += 4) {
  const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
  if (d > 1) differing++;
  if (d > worst) worst = d;
  const s = Math.max(Math.abs(a.data[i] - b.data[i] * gain), Math.abs(a.data[i + 1] - b.data[i + 1] * gain), Math.abs(a.data[i + 2] - b.data[i + 2] * gain));
  if (s > 1) differingScaled++;
  if (s > worstScaled) worstScaled = s;
}
const pixels = a.width * a.height;
console.log(`cache off: shaders ${off.shaders.toFixed(1)}s  first frame ${off.firstFrame.toFixed(1)}s  exposure ${off.exposure}`);
console.log(`cache on : shaders ${on.shaders.toFixed(1)}s  first frame ${on.firstFrame.toFixed(1)}s  exposure ${on.exposure}`);
console.log(`saved ${(off.shaders + off.firstFrame - on.shaders - on.firstFrame).toFixed(1)}s`);
console.log(`pixels differing by more than 1/255: ${differing} of ${pixels} (${(100 * differing / pixels).toFixed(3)}%), worst channel ${worst}/255`);
console.log(`after removing a global gain of ${gain.toFixed(4)}: ${differingScaled} (${(100 * differingScaled / pixels).toFixed(3)}%), worst ${worstScaled.toFixed(1)}/255`);
clearTimeout(gate);
