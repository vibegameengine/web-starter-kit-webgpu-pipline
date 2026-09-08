// Where the main thread spends a frame at 4K: CPU profile over ~4 s of steady
// frames, self time by function and by file, plus the rAF interval. Headed;
// 3-minute gate.
import { chromium } from 'playwright';
setTimeout(() => { console.error('gate: 3 minutes, abort'); process.exit(2); }, 180000);
const hd = process.argv.includes('--1080');
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: hd ? 1 : 2 });
const q = process.argv.indexOf('--query'); const query = q >= 0 ? process.argv[q + 1] : '';
await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0${process.argv.includes('--gputime') ? '&gputime=1' : ''}${query}`);
await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 170000 });
await page.evaluate(() => new Promise((resolve) => { let last = performance.now(), run = 0; const f = () => { const t = performance.now(); run = t - last < 500 ? run + 1 : 0; last = t; if (run >= 30) resolve(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
await cdp.send('Profiler.start');
const intervals = await page.evaluate(() => new Promise((resolve) => { const out = []; let last = performance.now(); const f = () => { const t = performance.now(); out.push(t - last); last = t; if (out.length >= 16) resolve(out); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
const { profile } = await cdp.send('Profiler.stop');
const byFn = new Map(), byFile = new Map();
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
let total = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const n = nodes.get(profile.samples[i]); const cf = n.callFrame; const ms = (profile.timeDeltas[i] ?? 0) / 1000; total += ms;
  const file = (cf.url.split('?')[0].split('/').slice(-2).join('/')) || `(${cf.functionName || 'native'})`;
  byFn.set(`${cf.functionName || '(anon)'} ${file}:${cf.lineNumber}`, (byFn.get(`${cf.functionName || '(anon)'} ${file}:${cf.lineNumber}`) ?? 0) + ms);
  byFile.set(file, (byFile.get(file) ?? 0) + ms);
}
const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`).join('\n');
const sorted = [...intervals].sort((a, b) => a - b);
console.log(`rAF interval median ${sorted[8].toFixed(0)} ms (min ${sorted[0].toFixed(0)}, max ${sorted[15].toFixed(0)}); profiled ${(total / 1000).toFixed(1)} s`);
console.log('--- self time by file'); console.log(top(byFile, 12));
console.log('--- self time by function'); console.log(top(byFn, 25));
await browser.close();
