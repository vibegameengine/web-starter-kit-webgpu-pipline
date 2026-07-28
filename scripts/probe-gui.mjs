// Reads every lil-gui controller (label → value) out of a running build.
// Used to prove two builds are actually configured the same before blaming shaders.
//
//   node scripts/probe-gui.mjs --url http://127.0.0.1:5188/ --wait 15000
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const url = flag('url', 'http://127.0.0.1:5188/');
const wait = Number(flag('wait', '15000'));

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--use-angle=d3d11',
    '--enable-webgpu-developer-features',
    '--no-sandbox',
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(wait);

const rows = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('.lil-gui .controller').forEach((c) => {
    const name = c.querySelector('.name')?.textContent?.trim() ?? '?';
    const input = c.querySelector('input, select');
    let value = '';
    if (input) {
      value = input.type === 'checkbox' ? String(input.checked) : String(input.value);
    }
    const folder =
      c.closest('.children')?.previousElementSibling?.textContent?.trim() ?? '';
    out.push(`${folder ? folder + ' / ' : ''}${name} = ${value}`);
  });
  return out;
});

console.log(url);
rows.forEach((r) => console.log('  ' + r));
await browser.close();
