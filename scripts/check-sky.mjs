import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const port = process.env.PORT ?? '5188';
const outDir = process.env.OUT ?? 'shots/sky';
const shots = (process.env.SHOTS ?? 'noon:45,golden:8,sunset:1.5,twilight:-4').split(',').map((entry) => {
  const [name, elevation] = entry.split(':');
  return { name, elevation: Number(elevation) };
});
const cam = process.env.CAM ?? 'sunward';
const bootBoundMs = Number(process.env.BOUND ?? 90000);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPUService', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

async function fail(reason) {
  console.error(`FAIL ${reason}`);
  for (const error of errors.slice(0, 8)) console.error(`  ${error.slice(0, 400)}`);
  await page.screenshot({ path: `${outDir}/failure.png` }).catch(() => {});
  await browser.close();
  process.exit(1);
}

await page.goto(`http://127.0.0.1:${port}/?scene=sky&cam=${cam}&hud=0&${process.env.QUERY ?? ''}`);
const booted = await page.waitForFunction(() => {
  const error = document.querySelector('#error-overlay');
  if (error && !error.hidden && !error.classList.contains('hidden')) return 'error';
  return window.__sky && document.querySelector('#loading-overlay')?.hidden ? 'ready' : false;
}, null, { timeout: bootBoundMs, polling: 250 }).then((handle) => handle.jsonValue()).catch(() => 'timeout');
if (booted !== 'ready') await fail(`boot ${booted}`);

for (const shot of shots) {
  await page.evaluate((elevation) => window.__audit.sun(-60, elevation), shot.elevation);
  await page.waitForTimeout(Number(process.env.SETTLE ?? 2500));
  if (errors.length) await fail(`errors after ${shot.name}`);
  const sunLight = await page.evaluate(() => window.__sky.sunLight());
  console.log(`${shot.name} elevation ${shot.elevation}: sun light rgb ${sunLight.map((v) => v.toFixed(3)).join(' ')}`);
  await page.screenshot({ path: `${outDir}/${cam}-${shot.name}.png` });
}
await browser.close();
