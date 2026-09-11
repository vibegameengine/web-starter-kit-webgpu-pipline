import { chromium } from 'playwright';
import { watchPipelineError } from './_harness.mjs';
import assert from 'node:assert/strict';

const query = process.env.LM_QUERY ?? '?scene=corridor&cam=bench&bakeCache=0';

const PROBE = `
  globalThis.__lmDump = (() => {
    const el = (m) => m.matrixWorld.elements;
    const wx = (e, x, y, z) => e[0]*x + e[4]*y + e[8]*z + e[12];
    const wy = (e, x, y, z) => e[1]*x + e[5]*y + e[9]*z + e[13];
    const wz = (e, x, y, z) => e[2]*x + e[6]*y + e[10]*z + e[14];
    const chartOfVertex = new Map();
    requests.forEach((c, ci) => {
      let map = chartOfVertex.get(c.mesh);
      if (!map) { map = new Map(); chartOfVertex.set(c.mesh, map); }
      for (const v of c.vertices) map.set(v, ci);
    });
    const coveredPerChart = new Map();
    const meshes = [];
    for (const [mesh, entry] of perMesh) {
      const vertexChart = chartOfVertex.get(mesh) ?? new Map();
      const g = mesh.geometry;
      const pos = g.getAttribute('position');
      const idx = g.index;
      const triCount = idx ? idx.count / 3 : Math.floor(pos.count / 3);
      const e = el(mesh);
      const cell = new Map();
      const buckets = [0, 0, 0, 0];
      let sameChart = 0;
      let crossChart = 0;
      let maxSpread = 0;
      let worst = null;
      for (let t = 0; t < triCount; t++) {
        const tri = [0, 1, 2].map((k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k));
        let cx = 0, cy = 0, cz = 0;
        let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
        for (const i of tri) {
          const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
          cx += wx(e, lx, ly, lz) / 3; cy += wy(e, lx, ly, lz) / 3; cz += wz(e, lx, ly, lz) / 3;
          const u = entry.uv1[i * 2] * atlasSize, v = entry.uv1[i * 2 + 1] * atlasSize;
          if (u < minU) minU = u; if (u > maxU) maxU = u;
          if (v < minV) minV = v; if (v > maxV) maxV = v;
        }
        const ux = tri.map((i) => entry.uv1[i * 2] * atlasSize);
        const vy = tri.map((i) => entry.uv1[i * 2 + 1] * atlasSize);
        const area = (ux[1] - ux[0]) * (vy[2] - vy[0]) - (ux[2] - ux[0]) * (vy[1] - vy[0]);
        if (Math.abs(area) < 1e-9) continue;
        for (let y = Math.floor(minV); y < Math.ceil(maxV); y++) {
          for (let x = Math.floor(minU); x < Math.ceil(maxU); x++) {
            const px = x + 0.5, py = y + 0.5;
            const w0 = ((ux[1] - px) * (vy[2] - py) - (ux[2] - px) * (vy[1] - py)) / area;
            const w1 = ((ux[2] - px) * (vy[0] - py) - (ux[0] - px) * (vy[2] - py)) / area;
            const w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const key = y * 8192 + x;
            const prev = cell.get(key);
            const chart = vertexChart.get(tri[0]) ?? -1;
            if (!prev) { cell.set(key, [cx, cy, cz, chart, ux.slice(), vy.slice()]); coveredPerChart.set(chart, (coveredPerChart.get(chart) ?? 0) + 1); continue; }
            const d = Math.hypot(prev[0] - cx, prev[1] - cy, prev[2] - cz);
            if (d > 0.5) { sameChart += prev[3] === chart ? 1 : 0; crossChart += prev[3] === chart ? 0 : 1; }
            if (d > 0.1) buckets[0]++;
            if (d > 0.25) buckets[1]++;
            if (d > 0.5) buckets[2]++;
            if (d > 1.0) buckets[3]++;
            if (d > maxSpread) { maxSpread = d; worst = { texel: [x, y], chartA: prev[3], chartB: chart, a: prev.slice(0, 3).map(n => +n.toFixed(2)), b: [cx, cy, cz].map(n => +n.toFixed(2)), uvA: prev[4].map(n => +n.toFixed(1)).concat(prev[5].map(n => +n.toFixed(1))), uvB: ux.map(n => +n.toFixed(1)).concat(vy.map(n => +n.toFixed(1))) }; }
          }
        }
      }
      meshes.push({ name: mesh.name || g.type, type: g.type, tris: triCount, atlasTexels: entry.texels,
        coveredTexels: cell.size, over: { d10: buckets[0], d25: buckets[1], d50: buckets[2], d100: buckets[3] }, sameChart, crossChart, geometryId: g.uuid.slice(0, 8),
        maxSpread: +maxSpread.toFixed(3), worst });
    }
    return { atlasSize, metresPerTexel, alignment, inset,
      charts: requests.map((c, i) => ({ i, mesh: c.mesh.name || c.mesh.geometry.type, x: c.x, y: c.y, w: c.w, h: c.h,
        extentU: +c.extentU.toFixed(3), extentV: +c.extentV.toFixed(3), verts: c.vertices.length })),
      requested: (() => { const names = new Map(); for (const c of requests) { const n = c.mesh.name || c.mesh.geometry.type; const e = names.get(n) ?? { charts: 0, placedCharts: 0 }; e.charts++; if (placed.includes(c)) e.placedCharts++; names.set(n, e); } return [...names].map(([name, e]) => ({ name, ...e })); })(),
      sample: (() => { const bad = requests.map((c, i) => i).filter((i) => !coveredPerChart.get(i)); if (!bad.length) return null; const c = requests[bad[0]]; const entry = perMesh.get(c.mesh); const local = { x: 0, y: 0, set(a, b) { this.x = a; this.y = b; } }; const rows = c.vertices.slice(0, 9).map((v) => { c.local(v, local); return { v, uv: [+(entry.uv1[v*2]*atlasSize).toFixed(2), +(entry.uv1[v*2+1]*atlasSize).toFixed(2)], local: [+local.x.toFixed(3), +local.y.toFixed(3)] }; }); return { chart: bad[0], rect: [c.x, c.y, c.w, c.h], extent: [c.extentU, c.extentV], rows }; })(),
      empties: requests.map((c, i) => i).filter((i) => !coveredPerChart.get(i)).map((i) => ({ i, mesh: requests[i].mesh.name, extentU: +requests[i].extentU.toFixed(5), extentV: +requests[i].extentV.toFixed(5), w: requests[i].w, h: requests[i].h, verts: requests[i].vertices.length })),
      meshes };
  })();
`;

const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/lightmapUv.ts*', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const patched = body.replace('const charts = [];\n  let cursor = 0;', `${PROBE}\n  const charts = [];\n  let cursor = 0;`);
    assert.notEqual(patched, body, 'probe must attach to the real layout pass');
    await route.fulfill({ response, body: patched });
  });
  await page.goto(`http://127.0.0.1:5188/${query}`);
  await Promise.race([watchPipelineError(page), page.waitForFunction(() => globalThis.__lmDump, null, { timeout: 300000 })]);
  const dump = await page.evaluate(() => globalThis.__lmDump);
  console.log(JSON.stringify({ query, errors, ...dump }, null, 1));
} finally { await browser.close(); }
