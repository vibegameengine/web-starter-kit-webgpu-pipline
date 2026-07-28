// Real-browser screenshot via system Chrome (WebGPU-capable).
// Usage: node scripts/capture-chrome.mjs [out.png] [--url ...] [--wait 8000] [--headed]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

const out = resolve(positional[0] ?? 'shots/chrome.png');
const url = flag('url', 'http://127.0.0.1:5188/');
const wait = Number(flag('wait', '10000'));
const width = Number(flag('w', '1600'));
const height = Number(flag('h', '900'));
const headed = has('headed');

mkdirSync(dirname(out), { recursive: true });

const chromeArgs = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,UseSkiaRenderer,WebGPUService',
  '--ignore-gpu-blocklist',
  '--disable-gpu-driver-bug-workarounds',
  '--use-angle=d3d11',
  '--enable-webgpu-developer-features',
  '--no-sandbox',
];

const browser = await chromium.launch({
  channel: 'chrome', // system Google Chrome — real WebGPU path
  headless: headed ? false : true,
  args: chromeArgs,
});

const page = await browser.newPage({
  viewport: { width, height },
  deviceScaleFactor: 1,
});

const errors = [];
const warnings = [];
page.on('console', (m) => {
  const t = m.type();
  const text = m.text();
  if (t === 'error') errors.push(text);
  if (t === 'warning') warnings.push(text);
});
page.on('pageerror', (e) => errors.push(String(e && e.stack ? e.stack : e)));

console.log(`→ channel=chrome headless=${!headed}`);
console.log(`→ loading ${url}`);

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

// Wait until loading overlay is gone OR error overlay is visible
const deadline = Date.now() + wait;
let state = 'waiting';
while (Date.now() < deadline) {
  state = await page.evaluate(() => {
    const load = document.querySelector('#loading-overlay');
    const err = document.querySelector('#error-overlay');
    const loadHidden =
      !load || load.hidden || load.classList.contains('hidden');
    const errVisible =
      err && !err.hidden && !err.classList.contains('hidden');
    const msg = document.querySelector('#loading-message')?.textContent ?? '';
    const errMsg = document.querySelector('#error-message')?.textContent ?? '';
    const canvas = !!document.querySelector('canvas');
    return { loadHidden, errVisible, msg, errMsg, canvas };
  });
  if (state.errVisible) break;
  if (state.loadHidden && state.canvas) {
    // extra settle for GI warm-up
    await page.waitForTimeout(2500);
    break;
  }
  await page.waitForTimeout(400);
}

// GPU / backend probe
const probe = await page.evaluate(async () => {
  const gpu = !!navigator.gpu;
  let adapter = null;
  try {
    if (navigator.gpu) {
      const a = await navigator.gpu.requestAdapter();
      adapter = a
        ? {
            has: true,
            // info may be undefined on older chrome
            vendor: a.info?.vendor ?? null,
            architecture: a.info?.architecture ?? null,
          }
        : { has: false };
    }
  } catch (e) {
    adapter = { has: false, error: String(e) };
  }
  return {
    gpu,
    adapter,
    title: document.title,
    loadMsg: document.querySelector('#loading-message')?.textContent,
    errMsg: document.querySelector('#error-message')?.textContent,
    loadHidden:
      document.querySelector('#loading-overlay')?.hidden ||
      document.querySelector('#loading-overlay')?.classList.contains('hidden'),
    errVisible: !!(
      document.querySelector('#error-overlay') &&
      !document.querySelector('#error-overlay').hidden &&
      !document.querySelector('#error-overlay').classList.contains('hidden')
    ),
  };
});

// Optional: open the three.js Inspector and select a tab, so the pass viewer
// (GBuffer / SSGI / shadow layers) can be verified without a human clicking.
let inspectorState = null;
if (has('inspector')) {
  const tab = flag('tab', 'Viewer');

  const opened = await page.evaluate(() => {
    const toggle = document.querySelector('#profiler-toggle');
    if (!toggle) return false;
    toggle.click();
    return true;
  });

  if (opened) {
    await page.waitForTimeout(400);
    // A real user click — the tab strip ignores synthetic .click() dispatches.
    await page
      .getByRole('button', { name: tab, exact: true })
      .first()
      .click({ timeout: 5000 })
      .catch((e) => console.log(`  ! tab "${tab}" click failed: ${e.message.split('\n')[0]}`));
    await page.waitForTimeout(600);

    // Expand every collapsed group so all registered buffers are visible.
    await page.evaluate(() => {
      document
        .querySelectorAll('.item-row:not(.open) .item-toggler')
        .forEach((el) => el.click());
    });
    await page.waitForTimeout(1000);

    inspectorState = await page.evaluate(() => {
      const active =
        document.querySelector('.profiler-content.active') ??
        document.querySelector('.profiler-content-wrapper');
      const tabs = Array.from(document.querySelectorAll('.tab-btn'))
        .map((b) => (b.textContent || '').trim())
        .filter((t) => t.length > 0 && t.length < 24);
      return { opened: true, tabs, text: (active?.innerText ?? '').slice(0, 2500) };
    });
  } else {
    inspectorState = { opened: false, tabs: [], text: '' };
  }
  await page.waitForTimeout(600);
}

await page.addStyleTag({
  content: '#stats,#boot,.lil-gui{opacity:0.85}',
}).catch(() => {});

await page.screenshot({ path: out, type: 'png', fullPage: false });

// pixel stats
const stats = await page.evaluate(async () => {
  // use page screenshot already saved; analyze via canvas from video frame if possible
  return null;
});

const buf = await page.screenshot({ type: 'png' });
// quick luminance via evaluate drawing is heavy; use simple file log
console.log(`✓ saved ${out}`);
console.log(`  probe: ${JSON.stringify(probe)}`);
if (inspectorState) {
  console.log(`  inspector: ${JSON.stringify({ opened: inspectorState.opened, tabs: inspectorState.tabs })}`);
  if (inspectorState.text) {
    console.log('  viewer entries:');
    inspectorState.text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((l) => console.log('   |', l));
  }
}
console.log(`  wait-state: ${JSON.stringify(state)}`);
if (warnings.length) {
  console.log(`  warnings (${warnings.length}):`);
  warnings.slice(0, 6).forEach((w) => console.log('   -', w.slice(0, 160)));
}
if (errors.length) {
  console.log(`  ⚠ errors (${errors.length}):`);
  errors.slice(0, 8).forEach((e) => console.log('   -', e.slice(0, 220)));
}

await browser.close();

const failed =
  probe.errVisible ||
  errors.some((e) => /WebGPU required|timed out|isInterleavedBufferAttribute/i.test(e));

if (failed) {
  console.error('✗ verification FAILED (error overlay or fatal console error)');
  process.exit(2);
}
if (!probe.gpu) {
  console.error('✗ navigator.gpu missing in this Chrome session');
  process.exit(3);
}
console.log('✓ capture finished');
void stats;
void buf;
