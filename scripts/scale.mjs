// Scale measurement harness.
//
// Drives the running page and prints, as numbers, every claim in docs/scale-report.md:
// BVH build wall-clock and triangle count, BVH buffer bytes, diffuse-array bytes,
// surfel pool bytes allocated vs surfels alive, lightmap atlas metres-per-texel, and
// median/p95 frame time. Reads window.__scale(), which sits on top of the existing
// window.__probe() / window.__surfels() rather than beside them.
//
// Usage:
//   node scripts/scale.mjs                                  # cornell + large
//   node scripts/scale.mjs --only large --wait 90000
//   node scripts/scale.mjs --q "?scene=large&seg=64&trees=16"
//   node scripts/scale.mjs --json out.json
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const all = (name) =>
  args.reduce((acc, a, i) => (a === `--${name}` && args[i + 1] ? [...acc, args[i + 1]] : acc), []);

const base = flag('url', 'http://127.0.0.1:5193/');
const wait = Number(flag('wait', '120000'));
const frames = Number(flag('frames', '240'));
const only = flag('only', null);
const jsonOut = flag('json', null);

// Both runs pin the mover out and use the same bake budget, so the only difference
// between the rows in the report is the scene.
const COMMON = 'hud=0&split=off&mover=0&bake=4000';
const explicit = all('q');
const cases = explicit.length
  ? explicit.map((q, i) => ({ name: `custom${i}`, query: q.replace(/^\?/, '') }))
  : [
      { name: 'cornell', query: COMMON },
      { name: 'large', query: `${COMMON}&scene=large` },
    ].filter((c) => !only || c.name === only);

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

const results = [];

for (const testCase of cases) {
  const url = `${base}?${testCase.query}`;
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  const logs = [];
  const errors = [];
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error') errors.push(text);
    if (/^\[(BVH|largeScene|lightmap)\]|BVH Build:/.test(text)) logs.push(text);
  });
  page.on('pageerror', (e) => errors.push(String(e?.stack ?? e)));

  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Boot is long on the large scene (texture load, tree generation, SAH BVH over
  // 100 k triangles, then the warm-up bake). Poll the overlay rather than guessing.
  let state = null;
  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    state = await page
      .evaluate(() => {
        const load = document.querySelector('#loading-overlay');
        const err = document.querySelector('#error-overlay');
        return {
          loadHidden: !load || load.hidden || load.classList.contains('hidden'),
          errVisible: !!(err && !err.hidden && !err.classList.contains('hidden')),
          msg: document.querySelector('#loading-message')?.textContent ?? '',
          errMsg: document.querySelector('#error-message')?.textContent ?? '',
          hasScale: typeof window.__scale === 'function',
        };
      })
      .catch(() => null);
    if (!state) break;
    if (state.errVisible) break;
    if (state.loadHidden && state.hasScale) break;
    await page.waitForTimeout(500);
  }
  const bootMs = Date.now() - t0;

  if (!state || state.errVisible || !state.hasScale) {
    results.push({
      case: testCase.name,
      url,
      bootMs,
      failed: true,
      state,
      errors: errors.slice(0, 6),
    });
    await page.close();
    continue;
  }

  // Let the cache settle past the bake before anything is read: a surfel count taken
  // mid-warm-up measures the warm-up, not the scene.
  await page.waitForTimeout(6000);

  const frameStats = await page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const samples = [];
        let last = performance.now();
        const tick = () => {
          const now = performance.now();
          samples.push(now - last);
          last = now;
          if (samples.length < n) requestAnimationFrame(tick);
          else {
            // Drop the first few: the rAF that follows the readback above is not a
            // steady-state frame.
            const s = samples.slice(5).sort((a, b) => a - b);
            resolve({
              samples: s.length,
              medianMs: +s[Math.floor(s.length * 0.5)].toFixed(2),
              p95Ms: +s[Math.floor(s.length * 0.95)].toFixed(2),
              maxMs: +s[s.length - 1].toFixed(2),
              fpsMedian: +(1000 / s[Math.floor(s.length * 0.5)]).toFixed(1),
            });
          }
        };
        requestAnimationFrame(tick);
      }),
    frames,
  );

  const scale = await page.evaluate(() => window.__scale());
  const surfels = await page.evaluate(() => window.__surfels());

  results.push({
    case: testCase.name,
    url,
    bootMs,
    frame: frameStats,
    scale,
    surfels,
    logs,
    errors: errors.slice(0, 6),
  });

  await page.close();
}

await browser.close();

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MiB`;
const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-GB') : String(v));

for (const r of results) {
  console.log(`\n=== ${r.case} ===`);
  console.log(r.url);
  if (r.failed) {
    console.log('  FAILED to boot', JSON.stringify(r.state));
    r.errors.forEach((e) => console.log('   !', e.slice(0, 300)));
    continue;
  }
  const s = r.scale;
  console.log(`  boot                     ${(r.bootMs / 1000).toFixed(1)} s`);
  console.log(
    `  meshes / instanced / instances   ${n(s.counts.meshes)} / ${n(s.counts.instancedMeshes)} / ${n(s.counts.instances)}`,
  );
  console.log(
    `  materials (with map)     ${n(s.counts.materials)} (${n(s.counts.materialsWithMap)})`,
  );
  console.log(
    `  world bounds             ${s.counts.bounds.size.map((v) => v.toFixed(1)).join(' x ')} m, diag ${s.counts.bounds.diagonal.toFixed(1)} m`,
  );
  console.log('  --- 1. scene BVH ---');
  console.log(`  build wall-clock         ${s.bvh.buildMs === null ? 'n/a' : `${s.bvh.buildMs.toFixed(0)} ms`}`);
  console.log(`  triangles in BVH         ${n(s.bvh.triangles)}   nodes ${n(s.bvh.nodes)}`);
  console.log(`  triangles rastered       ${n(s.counts.rasterTriangles)}`);
  console.log(
    `  full-detail / proxied / dropped   ${n(s.bvh.fullDetailTriangles ?? 0)} / ${n(s.bvh.proxiedTriangles ?? 0)} / ${n(s.bvh.droppedTriangles ?? 0)}`,
  );
  console.log(
    `  traced / drawn           ${(s.bvh.fractionTraced * 100).toFixed(2)} %  (missed ${n(s.bvh.trianglesMissedByInstancing)})`,
  );
  console.log(`  BVH buffers              ${mb(s.bvh.totalBytes)}  ${JSON.stringify(
    Object.fromEntries(Object.entries(s.bvh.bytes ?? {}).map(([k, v]) => [k, mb(v)])),
  )}`);
  console.log('  --- 2. lightmap atlas ---');
  console.log(`  atlas                    ${s.lightmap.atlasSize} px`);
  console.log(
    `  meshes with / without uv1  ${n(s.lightmap.meshesWithUv1)} / ${n(s.lightmap.meshesWithoutUv1)}  (instanced sharing one chart: ${n(s.lightmap.instancedMeshesShareUv1)})`,
  );
  console.log(`  lit world area           ${n(Math.round(s.lightmap.worldAreaM2))} m²`);
  console.log(
    `  metres per texel         aggregate ${s.lightmap.metresPerTexelAggregate.toFixed(3)} · median ${s.lightmap.metresPerTexelMedian.toFixed(3)} · p95 ${s.lightmap.metresPerTexelP95.toFixed(3)}`,
  );
  for (const chart of s.lightmap.sharedCharts ?? []) {
    console.log(
      `  shared chart "${chart.name}"   ${n(chart.instances)} instances · ${n(Math.round(chart.worldAreaAllInstancesM2))} m² share ${chart.texels.toFixed(1)} texels → ${chart.metresPerTexel.toFixed(1)} m/texel`,
    );
  }
  console.log('  --- 3. diffuse array ---');
  console.log(
    `  layers x size            ${n(s.diffuseArray.layers)} x ${s.diffuseArray.layerSize}²  mipmapped=${s.diffuseArray.mipmapped} (${s.diffuseArray.mipLevels ?? 1} levels)  for ${n(s.diffuseArray.uniqueMaterials)} materials`,
  );
  console.log(
    `  bytes                    ${mb(s.diffuseArray.totalBytes)} (${mb(s.diffuseArray.bytesPerLayer)} per layer)`,
  );
  console.log('  --- 4. surfel pool ---');
  console.log(
    `  capacity                 ${n(s.surfelPool.capacity)} @ ${n(s.surfelPool.bytesPerSurfel)} B = ${mb(s.surfelPool.totalGpuBytes)} GPU + ${mb(s.surfelPool.totalHostBytes)} host`,
  );
  console.log(
    `  alive                    ${n(s.surfelPool.alive)} (pinned ${n(s.surfelPool.pinned)}, live ${n(s.surfelPool.live)}) = ${(s.surfelPool.utilisation * 100).toFixed(2)} % · ${mb(s.surfelPool.liveBytes)} useful`,
  );
  console.log('  --- 5. surfel hash grid ---');
  console.log(
    `  cascades                 ${s.surfelGrid.cascades} x ${s.surfelGrid.cellsPerCascadeEdge}³ @ ${s.surfelGrid.cellDiameterM} m → ±${s.surfelGrid.outerCascadeHalfExtentM.toFixed(1)} m`,
  );
  console.log(
    `  surfel radius            ${s.surfelGrid.radiusAtM.map((r) => `${r.distance}m:${r.radius.toFixed(2)}m`).join('  ')}`,
  );
  console.log('  --- frame ---');
  console.log(
    `  frame time               median ${r.frame.medianMs} ms (${r.frame.fpsMedian} fps) · p95 ${r.frame.p95Ms} ms · max ${r.frame.maxMs} ms`,
  );
  console.log(
    `  renderer.info            draws ${n(s.renderer.drawCalls)} · tris ${n(s.renderer.renderTriangles)} · compute ${n(s.renderer.computeCalls)} · gpu render ${s.renderer.renderTimestampMs ?? 'n/a'} ms · gpu compute ${s.renderer.computeTimestampMs ?? 'n/a'} ms`,
  );
  if (r.logs.length) {
    console.log('  page logs:');
    r.logs.forEach((l) => console.log('   |', l.slice(0, 180)));
  }
  if (r.errors.length) {
    console.log('  errors:');
    r.errors.forEach((e) => console.log('   !', e.slice(0, 220)));
  }
}

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(results, null, 1));
  console.log(`\n→ ${jsonOut}`);
}
