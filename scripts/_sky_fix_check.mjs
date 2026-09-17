import { chromium } from 'playwright';
const port = process.env.PORT ?? '5188';
const out = process.env.OUT ?? 'shots/fix';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
async function boot(query) {
  await page.goto(`http://127.0.0.1:${port}/?scene=sky&hud=0&bakeCache=0&${query}`);
  const ok = await page.waitForFunction(() => window.__skyBake && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 150000 }).then(() => true).catch(() => false);
  if (!ok || errors.length) { console.log('FAIL boot', query, errors.slice(0, 4)); await browser.close(); process.exit(1); }
}
const step = process.env.STEP ?? 'all';
if (step === 'all' || step === 'moved') {
  await boot('cam=objects&sunAz=-60&sunEl=45');
  await page.evaluate(() => window.__audit.sun(-60, 2));
  await page.waitForTimeout(3000);
  console.log('status after move:', await page.evaluate(() => window.__skyBake.status()));
  await page.screenshot({ path: `${out}/moved-before-bake.png` });
  await page.evaluate(() => window.__skyBake.bakeFromSky());
  await page.waitForFunction(() => !/baking/.test(window.__skyBake.status()), null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(4000);
  console.log('status after bake:', await page.evaluate(() => window.__skyBake.status()));
  await page.screenshot({ path: `${out}/moved-after-bake.png` });
}
if (step === 'all' || step === 'disc') {
  await boot('cam=sunward&sunAz=-25&sunEl=2&sunDiscScale=4');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/disc-sunset.png` });
  await page.evaluate(() => window.__audit.sun(-25, 30));
  await page.evaluate(() => window.__camera(-2, 1.4, 7, 30, 26, -20));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/disc-day.png` });
}
if (step === 'all' || step === 'altitude') {
  await boot('cam=horizon&sunAz=-90&sunEl=20&skyAltitude=12');
  await page.evaluate(() => window.__camera(0, 40, 8, 0, 0, -70));
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}/altitude-12km.png` });
}
if (step === 'all' || step === 'resize') {
  await boot('cam=horizon&sunAz=-60&sunEl=40&cloudCoverage=0.5');
  await page.setViewportSize({ width: 800, height: 900 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/resize-narrow.png` });
  await page.setViewportSize({ width: 1900, height: 1000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/resize-wide.png` });
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close();
