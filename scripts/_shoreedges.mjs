import { chromium } from 'playwright';
import * as THREE from 'three';
import { PNG } from 'pngjs';
import fs from 'node:fs';
// Critic measurer: along rows z, one GPU moment each — where the solver is wet, where the
// sheet's film gate would draw (1.5 mm) and be opaque (9.5 mm), where the foam source /
// foam field / wetness field end. Screenshots are annotated with those edges projected
// through the `cam=shore` camera: red=solver 1 mm, blue=film 9.5 mm (opaque), cyan=film
// 5.5 mm (half), magenta=foam R>=0.2, white=R>=0.05, green=wetness G>=0.3, yellow=still line.
// Usage: node scripts/_shoreedges.mjs --zs 0.8,1.5,2.2 --n 8 --gap 250 --out shots/beach/critic2-edges [--query "&waterFilm=0"]
const args = process.argv.slice(2); const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const zs = arg('--zs', '1.5').split(',').map(Number); const n = Number(arg('--n', '6')); const out = arg('--out', 'shots/beach/critic2-edges');
const extra = arg('--query', ''); const shotEvery = Number(arg('--shot', '3'));
const cam = new THREE.PerspectiveCamera(27, 1600 / 900, 0.1, 100); cam.position.set(1.8, 2.4, 6.5); cam.lookAt(0.2, -0.3, 1.5); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
const project = (x, y, z) => { const v = new THREE.Vector3(x, y, z).project(cam); return [Math.round((v.x * 0.5 + 0.5) * 1600), Math.round((0.5 - v.y * 0.5) * 900)]; };
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-gpu-driver-bug-workarounds', '--use-angle=d3d11', '--enable-webgpu-developer-features'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&mode=surfel&bake=0&cam=shore${extra}`);
await page.waitForFunction(() => !!window.__lagoon?.shoreSnapshot && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 300000 });
await page.waitForTimeout(4000);
const c0 = await page.evaluate(() => window.__lagoon.simClock()); await page.waitForTimeout(3000); const c1 = await page.evaluate(() => window.__lagoon.simClock());
console.log('clock ratio sim/wall', ((c1.simTime - c0.simTime) / ((c1.now - c0.now) / 1000)).toFixed(3));
const fps = await page.evaluate(() => new Promise((r) => { let f = 0; const t0 = performance.now(); const tick = () => { f++; if (performance.now() - t0 > 2000) r(f / ((performance.now() - t0) / 1000)); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); }));
console.log('fps', fps.toFixed(1));
const scanLast = (R, pred, minFrac = 0.3) => { let e = -1; for (let i = Math.floor(R.length * minFrac); i < R.length - 3; i++) { if (pred(R[i])) e = i; else if (e >= 0 && !pred(R[i + 1]) && !pred(R[i + 2])) break; } return e; };
const edgeIdx = (s) => { const R = s.rows; return {
  solver1mm: scanLast(R, (r) => r[1] > 0.001), film1_5mm: scanLast(R, (r) => r[2] >= 0.0015), film5_5mm: scanLast(R, (r) => r[2] >= 0.0055), film9_5mm: scanLast(R, (r) => r[2] >= 0.0095),
  src: scanLast(R, (r) => r[5] > 0.05), R20: scanLast(R, (r) => r[6] >= 0.2), R05: scanLast(R, (r) => r[6] >= 0.05), G30: scanLast(R, (r) => r[7] >= 0.3), G02: scanLast(R, (r) => r[7] >= 0.02), stillLine: scanLast(R, (r) => r[8] <= 0) }; };
const colors = { solver1mm: [255, 0, 0], film9_5mm: [0, 0, 255], film5_5mm: [0, 255, 255], R20: [255, 0, 255], R05: [255, 255, 255], G30: [0, 255, 0], stillLine: [255, 255, 0] };
const tip = (s, e) => { const R = s.rows; const a = Math.max(0, (e.film9_5mm >= 0 ? e.film9_5mm : e.solver1mm) - 3); const b = Math.min(R.length - 1, e.solver1mm + 2); const rows = []; for (let i = a; i <= b; i++) { const r = R[i]; rows.push([r[0].toFixed(2), (r[1] * 1000).toFixed(1), (r[2] * 1000).toFixed(1), r[3].toFixed(2), r[5].toFixed(2), r[6].toFixed(2), r[7].toFixed(2), r[8].toFixed(3)].join('\t')); } return 'x\tdepth_mm\tfilm_mm\tu\tsrc\tR\tG\tbed-lvl\n' + rows.join('\n'); };
for (let k = 0; k < n; k++) {
  const marks = [];
  for (const z of zs) {
    const s = await page.evaluate((zz) => window.__lagoon.shoreSnapshot(zz), z);
    const e = edgeIdx(s); const R = s.rows;
    const xo = (i) => (i < 0 ? null : Number(R[i][0].toFixed(3)));
    const line = { k, z, t: s.simTime.toFixed(2) }; for (const key of Object.keys(e)) line[key] = xo(e[key]);
    line.gap_solver_minus_film9_5 = e.solver1mm >= 0 && e.film9_5mm >= 0 ? Number((R[e.solver1mm][0] - R[e.film9_5mm][0]).toFixed(3)) : null;
    { let mR = 0, xR = null, mG = 0; const sl = e.stillLine; for (let i = Math.max(0, sl); i < R.length; i++) { const r = R[i]; if (r[1] <= 0.001) { if (r[6] > mR) mR = r[6]; if (r[6] >= 0.15) xR = Number(r[0].toFixed(3)); if (r[7] > mG) mG = r[7]; } } line.dry_maxR = Number(mR.toFixed(2)); line.dry_R15_xmax = xR; line.dry_R15_ahead = xR !== null && e.solver1mm >= 0 ? Number((xR - R[e.solver1mm][0]).toFixed(3)) : null; line.dry_maxG = Number(mG.toFixed(2)); }
    console.log(JSON.stringify(line));
    if (k % shotEvery === 0 && z === zs[0]) console.log(tip(s, e));
    for (const key of Object.keys(colors)) if (e[key] >= 0) { const r = R[e[key]]; marks.push({ key, px: project(r[0], s.level + r[8] + 0.01, z) }); }
  }
  if (k % shotEvery === 0) {
    const path = `${out}-${k}.png`; await page.screenshot({ path });
    const png = PNG.sync.read(fs.readFileSync(path));
    for (const m of marks) { const [px, py] = m.px; const c = colors[m.key]; for (let dy = -14; dy <= 14; dy++) for (let dx = -1; dx <= 1; dx++) { const X = px + dx, Y = py + dy; if (X >= 0 && X < 1600 && Y >= 0 && Y < 900) { const o = (Y * 1600 + X) * 4; png.data[o] = c[0]; png.data[o + 1] = c[1]; png.data[o + 2] = c[2]; } } }
    fs.writeFileSync(path, PNG.sync.write(png)); console.log('shot', path, JSON.stringify(marks.map((m) => [m.key, m.px])));
  }
  await page.waitForTimeout(Number(arg('--gap', '250')));
}
await browser.close();
