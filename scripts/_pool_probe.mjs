// What the pool holds after a Cornell boot: console lines from the bake, the pool
// stats and whether the atlas is pinned. Read-only, headed, gate 3 minutes.
import { chromium } from 'playwright';
setTimeout(() => { console.error('gate: 3 minutes, abort'); process.exit(2); }, 180000);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const lines = [];
page.on('console', (m) => { const t = m.text(); if (/\[gi\]|\[lightmap\]|\[bake-cache\]|\[surfel-cache\]|\[palm\]|\[shrub\]|BVH|triangles/.test(t)) lines.push(`${m.type() === 'warning' ? 'WARN ' : m.type() === 'error' ? 'ERR  ' : '     '}${t.slice(0, 150)}`); });
await page.goto(`http://127.0.0.1:5188/?hud=0${process.argv[2] ?? ''}`);
await page.waitForFunction(() => window.__audit && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 150000 });
await page.evaluate(() => new Promise((r) => { let n = 0; const f = () => { n += 1; if (n >= 60) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
const state = await page.evaluate(() => ({ lighting: window.__audit.lighting(), transport: window.__audit.bakedTransport(), memory: window.__audit.memory?.() }));
console.log(lines.join('\n'));
console.log('lighting  ', JSON.stringify(state.lighting));
console.log('pool      ', JSON.stringify(state.transport?.livePool ?? null));
console.log('released  ', state.transport?.releasedBakePoolBytes);
await browser.close();
