import { chromium } from 'playwright';

const GATE_MS = Number(process.env.GATE_MS ?? 420000);
const gate = setTimeout(() => { console.error(`gate: ${GATE_MS / 1000}s, abort`); process.exit(2); }, GATE_MS);
const port = process.env.PORT ?? '5188';
const query = process.env.QUERY ?? 'scene=midsee-village&hud=0';

const probe = () => {
  const w = window;
  w.__stages = { marks: [], overlay: null, steady: null };
  const mark = (label) => w.__stages.marks.push([label, Math.round(performance.now())]);
  const start = () => {
    const message = document.querySelector('#loading-message');
    if (!message) { requestAnimationFrame(start); return; }
    mark(message.textContent ?? '');
    new MutationObserver(() => mark(document.querySelector('#loading-message')?.textContent ?? '')).observe(message, { childList: true, characterData: true, subtree: true });
  };
  start();
  let last = performance.now(), run = 0;
  const tick = () => {
    const t = performance.now(), d = t - last;
    if (w.__stages.overlay === null && document.querySelector('#loading-overlay')?.hidden) { w.__stages.overlay = Math.round(t); mark('[overlay hidden]'); }
    if (w.__stages.overlay !== null) { run = d < 100 ? run + 1 : 0; if (run >= 30 && w.__stages.steady === null) { w.__stages.steady = Math.round(t); mark('[steady frames]'); } }
    last = t; requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
let failure = null;
page.on('pageerror', (error) => { failure = error.message; });
page.on('console', (m) => { if (m.type() === 'error') failure ??= m.text().slice(0, 400); });
await page.addInitScript(probe);
await page.goto(`http://127.0.0.1:${port}/?${query}`);
try {
  await page.waitForFunction(() => window.__stages?.steady !== null || document.querySelector('#error-overlay:not([hidden])'), null, { timeout: GATE_MS - 30000, polling: 500 });
} catch (error) {
  console.error(`did not settle: ${error.message.split('\n')[0]}`);
}
const stages = await page.evaluate(() => window.__stages);
const marks = stages.marks;
const rows = marks.map(([label, at], i) => [label.replace(/\s*·.*$/, '').trim(), at, (i + 1 < marks.length ? marks[i + 1][1] : at) - at]);
rows.sort((a, b) => b[2] - a[2]);
console.log(`total to steady: ${stages.steady === null ? 'never' : (stages.steady / 1000).toFixed(1) + 's'}  overlay hidden: ${stages.overlay === null ? 'never' : (stages.overlay / 1000).toFixed(1) + 's'}`);
console.log('slowest stages (s):');
for (const [label, at, took] of rows.slice(0, 25)) console.log(`  ${(took / 1000).toFixed(2).padStart(7)}  at ${(at / 1000).toFixed(1).padStart(6)}s  ${label}`);
if (failure) console.log(`page error: ${failure}`);
await browser.close();
clearTimeout(gate);
