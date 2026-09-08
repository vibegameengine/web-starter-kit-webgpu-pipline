// Divide-and-conquer probe for "TAA output ≈ no AA": per config, the resolve's state
// over 6 frames, the frond-region stair steps of one frame, and the frame-to-frame
// change of the resolved texture (a still scene). Headed.
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { readFile } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const luma = (img, x, y) => { const p = (y * img.width + x) * 4; return 0.2126 * img.data[p] + 0.7152 * img.data[p + 1] + 0.0722 * img.data[p + 2]; };
const steps = (img) => { let n = 0; for (let y = 100; y < 500; y++) for (let x = 401; x < 1300; x++) if (Math.abs(luma(img, x, y) - luma(img, x - 1, y)) > 48) n++; return n; };
const configs = (process.argv[2] ?? 'default,history1,clip100,copy,none').split(',');
const quiet = '&contact=0&reflections=0&gi=0&shadowFilter=receiverPlane&glare=0&fog=0';
const q = { quietTaa: quiet, quietNone: quiet + '&aa=none', quietHistory0: quiet + '&taaHistory=0', default: '', history1: '&taaHistory=1', clip100: '&taaClip=100', copy: '&taaCopy=1', none: '&aa=none', history0: '&taaHistory=0', history1clip100: '&taaHistory=1&taaClip=100', unjitter1: '&taaUnjitter=1', unjitterm1: '&taaUnjitter=-1' };
for (const c of configs) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&still=1&cam=leaves&grain=0&exposure=1${q[c]}`);
  await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
  await page.waitForTimeout(4000);
  const r = await page.evaluate(async () => {
    const states = [];
    for (let i = 0; i < 6; i++) { await new Promise((res) => requestAnimationFrame(res)); states.push(window.__fog.taaState?.()); }
    const diff = (a, b) => { let d = 0, n = 0; for (let k = 0; k < a.length; k += 4) { d += Math.abs(a[k] - b[k]) + Math.abs(a[k+1] - b[k+1]) + Math.abs(a[k+2] - b[k+2]); n += 3; } return (d / n) * 255; };
    const taa = window.__fog.aa() === 'taa'; const zero = new Float32Array(4);
    const a = taa ? (await window.__fog.taaFrame()).data : zero; const sa = (await window.__fog.sceneFrame()).data;
    await new Promise((res) => requestAnimationFrame(res));
    const b = taa ? (await window.__fog.taaFrame()).data : zero; const sb = (await window.__fog.sceneFrame()).data;
    return { states, resolvedDelta: diff(a, b), sceneDelta: diff(sa, sb), resolvedVsScene: diff(b, sb) };
  });
  await page.screenshot({ path: `shots/taa/dc-${c}.png` });
  const img = PNG.sync.read(await readFile(`shots/taa/dc-${c}.png`));
  const s = r.states.map((x) => x ? `${x.historyReady ? 'R' : 'r'}${x.historyValid}p${x.parity}w${x.weight}j${x.jitter.map((v) => v.toFixed(2))}` : '-');
  console.log(c, 'steps', steps(img), 'resolvedDelta', r.resolvedDelta.toFixed(3), 'sceneDelta', r.sceneDelta.toFixed(3), 'resolvedVsScene', r.resolvedVsScene.toFixed(3), 'states', s.join(' '), errors.length ? 'ERR ' + errors[0] : '');
  await page.close();
}
await browser.close();
