/* @important Section 04 of the look document, the guiSettings trap: the lighting panel is
   built after staticLight.prepare(), so a saved profile used to reach the controls only
   after the first bake had already run with the code defaults - the panel then showed
   numbers the atlas had never seen. The profile has to be read into the state model before
   the bake. The proof is staticLight.bakedWith, recorded inside bakeAtlas. */
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { readdirSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const PORT = process.env.DEV_PORT ?? '5190';
const SCENE = process.env.ORDER_SCENE ?? 'corridor';
const PASSES = Number(process.env.ORDER_PASSES ?? 160);
const ATLAS_MUL = 0.7;
const BOOT_MS = 400000;
const PROFILE = `config/gui-settings.${SCENE}.json`;

const chromeArgs = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--no-sandbox'];
const failures = [];
const expect = (name, condition, detail) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(name);
};

const saved = existsSync(PROFILE) ? readFileSync(PROFILE, 'utf8') : null;
mkdirSync('config', { recursive: true });
writeFileSync(PROFILE, JSON.stringify({
  controllers: {},
  folders: {
    'GI bake': { controllers: { 'lightmap passes': PASSES }, folders: {} },
    Lighting: { controllers: { 'atlas mul': ATLAS_MUL }, folders: {} },
  },
}, null, 2));

const key = createHash('sha256').update(`bake:${SCENE}`).digest('hex');
for (const name of readdirSync('public/bakes')) if (name.startsWith(key)) rmSync(`public/bakes/${name}`);

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: chromeArgs });
const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
page.on('pageerror', (error) => { console.log(`FAIL page error: ${error}`); failures.push('page error'); });

try {
  await page.goto(`http://127.0.0.1:${PORT}/?scene=${SCENE}&settings=scene&hud=0`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const ready = await page.waitForFunction(() => {
    const error = document.querySelector('#error-overlay');
    if (error && !error.hidden && !error.classList.contains('hidden')) return { error: document.querySelector('#error-message')?.textContent ?? 'error overlay' };
    const loading = document.querySelector('#loading-overlay');
    return (!loading || loading.hidden || loading.classList.contains('hidden')) && window.__audit ? { ready: true } : false;
  }, null, { timeout: BOOT_MS, polling: 500 }).then((handle) => handle.jsonValue());
  if (ready.error) throw new Error(`pipeline error: ${ready.error}`);

  const state = await page.evaluate(() => ({ status: window.__audit.bakeStatus(), cache: window.__audit.bakeCache() }));
  expect('the bake was fresh, so it had to read the settings itself', state.cache.source === 'baked', `source ${state.cache.source}`);
  expect('the fresh bake ran with the profile pass count', state.status.bakedWith?.passes === PASSES, `bakedWith ${JSON.stringify(state.status.bakedWith)}`);
  expect('and with the profile atlas multiplier', state.status.bakedWith?.atlasIntensity === ATLAS_MUL, `atlas mul ${state.status.bakedWith?.atlasIntensity}`);

  const panel = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.lil-gui .controller')].map((row) => [row.querySelector('.name')?.textContent, row.querySelector('input')?.value]);
    return Object.fromEntries(rows.filter(([name]) => name === 'lightmap passes' || name === 'atlas mul'));
  });
  expect('the panel shows the same numbers the atlas was baked with', Number(panel['lightmap passes']) === PASSES && Number(panel['atlas mul']) === ATLAS_MUL, JSON.stringify(panel));
} catch (error) {
  console.log(`FAIL ${error.message}`);
  failures.push(error.message);
} finally {
  await browser.close();
  if (saved === null) rmSync(PROFILE, { force: true });
  else writeFileSync(PROFILE, saved);
}

console.log(failures.length ? `FAILED: ${failures.join(', ')}` : 'OK lighting settings are read before the bake');
process.exit(failures.length ? 1 : 0);
