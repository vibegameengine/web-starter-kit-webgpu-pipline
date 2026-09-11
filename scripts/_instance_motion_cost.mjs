import { chromium } from 'playwright';

const port = process.env.PORT ?? '5188';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
for (const instanceMotion of (process.env.VARIANTS ?? '0,1,0,1').split(',').map(Number)) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/?scene=${process.env.SCENE ?? 'village-light'}&hud=0&still=1&gputime=1&instanceMotion=${instanceMotion}`);
  const booted = await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: Number(process.env.BOUND ?? 30000) }).then(() => true).catch(() => false);
  if (!booted) { console.error('boot failed'); process.exit(1); }
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => window.__gpuPasses(150));
  console.log(`instanceMotion=${instanceMotion}`, JSON.stringify({ gpuMs: +r.gpuMs.toFixed(2), frameMs: +r.frameMs.toFixed(2), frames: r.framesUsed }));
  await page.close();
}
await browser.close();
