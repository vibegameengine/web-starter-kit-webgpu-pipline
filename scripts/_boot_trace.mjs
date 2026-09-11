import { chromium } from 'playwright';
import { watchPipelineError } from './_harness.mjs';
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const started = Date.now();
  page.on('console', (m) => {
    const t = m.text();
    if (/lightmap|probes|boot|charts|page/i.test(t)) console.log(`${((Date.now() - started) / 1000).toFixed(1)}s ${t.slice(0, 150)}`);
  });
  const failed = watchPipelineError(page);
  failed.catch((error) => { console.log('FAILED', String(error).slice(0, 300)); process.exit(1); });
  await page.goto(`http://127.0.0.1:5188/${process.env.LM_QUERY ?? '?scene=corridor&cam=bench'}`);
  await Promise.race([failed, page.waitForTimeout(Number(process.env.WATCH_MS ?? 120000))]);
} finally { await browser.close(); }
