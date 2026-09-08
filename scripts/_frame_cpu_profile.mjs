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
// The hot path: total time per node (self + descendants) down the heaviest chain,
// so a cost inside three's node system says which of OUR calls pays for it.
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const selfById = new Map();
for (let i = 0; i < profile.samples.length; i++) selfById.set(profile.samples[i], (selfById.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
const totalById = new Map();
for (const [id, ms] of selfById) { let cur = id; const seen = new Set(); while (cur !== undefined && !seen.has(cur)) { seen.add(cur); totalById.set(cur, (totalById.get(cur) ?? 0) + ms); cur = parent.get(cur); } }
const label = (id) => { const cf = nodes.get(id).callFrame; return `${cf.functionName || '(anon)'} ${(cf.url.split('?')[0].split('/').slice(-2).join('/')) || 'native'}:${cf.lineNumber}`; };
const root = profile.nodes.find((n) => n.callFrame.functionName === '(root)')?.id ?? profile.nodes[0].id;
const path = [];
let cur = root;
for (let depth = 0; depth < 24; depth++) {
  const kids = (nodes.get(cur).children ?? []).map((id) => [id, totalById.get(id) ?? 0]).sort((a, b) => b[1] - a[1]);
  if (!kids.length || kids[0][1] < total * 0.05) break;
  path.push(`${(100 * kids[0][1] / total).toFixed(1).padStart(5)}%  ${'  '.repeat(depth)}${label(kids[0][0])}`);
  cur = kids[0][0];
}
const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`).join('\n');
const sorted = [...intervals].sort((a, b) => a - b);
console.log(`rAF interval median ${sorted[8].toFixed(0)} ms (min ${sorted[0].toFixed(0)}, max ${sorted[15].toFixed(0)}); profiled ${(total / 1000).toFixed(1)} s`);
console.log('--- hot path (total time)');
console.log(path.join(String.fromCharCode(10)));
console.log('--- self time by file'); console.log(top(byFile, 12));
console.log('--- self time by function'); console.log(top(byFn, 25));
await browser.close();
