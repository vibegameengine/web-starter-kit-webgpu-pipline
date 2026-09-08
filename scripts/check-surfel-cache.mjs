// The surfel cache is warmed once and read from disk after that (headed, always).
//
//   node scripts/check-surfel-cache.mjs
//
// Boot 1 with the cache cleared: the scene warms and saves. Boot 2: no warming at
// all, the cache is restored, and the frame it produces matches boot 1's within the
// renderer's own frame-to-frame drift. Boot 2 must also reach a rendered frame
// sooner than boot 1 did. A cache that is written but never read, or read into a
// different-looking frame, fails here.
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

setTimeout(() => { console.error('check-surfel-cache: 3-minute gate hit, aborting'); process.exit(2); }, 180000);
await mkdir('shots/surfel-cache', { recursive: true });
execFileSync(process.execPath, ['scripts/bake-clear.mjs', '--yes'], { stdio: 'inherit' });

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const luma = (img, i) => 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
const meanDiff = (a, b) => { let s = 0, n = 0; for (let i = 0; i < a.data.length; i += 4) { s += Math.abs(luma(a, i) - luma(b, i)); n++; } return s / n; };

const boot = async (label) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const log = [];
  page.on('console', (m) => { const t = m.text(); if (/surfel-cache|bake-cache|\[gi\] baked/.test(t)) log.push(t.slice(0, 140)); });
  const started = Date.now();
  await page.goto('http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&still=1&mode=surfel&grain=0&exposure=1');
  await page.waitForFunction(() => window.__audit && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 120000 });
  const readySeconds = (Date.now() - started) / 1000;
  await page.evaluate(() => new Promise((resolve) => { let last = performance.now(), run = 0; const f = () => { const t = performance.now(); run = t - last < 500 ? run + 1 : 0; last = t; if (run >= 45) resolve(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
  const png = await page.screenshot();
  await writeFile(`shots/surfel-cache/${label}.png`, png);
  const cache = await page.evaluate(() => window.__audit.bakeCache());
  await page.close();
  return { readySeconds, cache, log, image: PNG.sync.read(png) };
};

const cold = await boot('cold');
const warm = await boot('warm');
const drift = await boot('warm2');
const report = {
  cold: { seconds: +cold.readySeconds.toFixed(1), source: cold.cache.source, saved: cold.cache.saved, error: cold.cache.error },
  warm: { seconds: +warm.readySeconds.toFixed(1), source: warm.cache.source, saved: warm.cache.saved, error: warm.cache.error },
  frameDiff: +meanDiff(cold.image, warm.image).toFixed(2),
  driftBetweenRestores: +meanDiff(warm.image, drift.image).toFixed(2),
};
console.log(JSON.stringify(report, null, 2));
console.log(['cold:', ...cold.log, 'warm:', ...warm.log].join('\n  '));

assert.equal(cold.cache.saved, true, `the first launch must save the cache: ${cold.cache.error}`);
assert.equal(warm.cache.source, 'saved', 'the second launch must restore the cache, not bake');
assert.ok(!warm.log.some((line) => line.includes('[gi] baked')), 'the second launch must not warm');
assert.ok(warm.readySeconds < cold.readySeconds, `restoring must be faster than warming: ${JSON.stringify(report)}`);
assert.ok(report.frameDiff < report.driftBetweenRestores * 2 + 2, `the restored frame must match the warmed one: ${JSON.stringify(report)}`);
console.log('check-surfel-cache: PASS');
await browser.close();
