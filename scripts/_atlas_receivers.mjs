import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';
const port = process.env.PORT ?? '5188';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://127.0.0.1:${port}/?scene=village-light&cam=quay&light=v2&still=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
const { failed } = await bootOrFail(page, 120000);
await Promise.race([failed, page.waitForTimeout(1500)]);
const rows = await page.evaluate(() => window.__atlasLight?.receivers() ?? []);
const group = new Map();
for (const row of rows) {
  const key = `${row.giStatic ? 'giStatic' : 'other'} uv1=${row.uv1} receiver=${row.receiver}`;
  const entry = group.get(key) ?? { meshes: 0, triangles: 0, names: [] };
  entry.meshes++; entry.triangles += row.triangles;
  if (entry.names.length < 6) entry.names.push(row.name);
  group.set(key, entry);
}
for (const [key, entry] of group) console.log(`${key}: ${entry.meshes} meshes, ${entry.triangles} tris — ${entry.names.join(', ')}`);
await browser.close();
