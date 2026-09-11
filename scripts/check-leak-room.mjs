/* @important Scenes A1 and A2 of public/bake-light-leaks-design.html, the oracle every later fix is
   measured against. The sealed room's true interior irradiance is zero, so whatever the atlas holds
   on its inner faces is the leak in physical units. The paired test is the same room with a real
   slit: darkness alone is not a pass, because thicker walls and a darker bake would also produce it.
   Reads the baked atlas through ?leak=1 rather than the screen, so tone mapping, exposure and the
   probes cannot flatter or spoil the number. Headed, per the project rule. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

setTimeout(() => { console.error('gate: 6 minutes, abort'); process.exit(2); }, 360000);
const out = 'shots/leak-room';
await mkdir(out, { recursive: true });
const cam = process.argv[2] ?? 'contact';
const gaps = (process.argv[3] ?? '0,1,5,20').split(',').map(Number);
const extra = process.argv[4] ?? '';
const base = `http://127.0.0.1:5188/?scene=leak-room&cam=${cam}&leak=1&hud=0&inspector=0&still=1&aa=none&grain=0&exposure=1${extra}`;
const tag = extra.replace(/[^a-z0-9]+/gi, '') || 'default';

const scaleMatch = /[?&]scale=([0-9.eE+-]+)/.exec(extra);
const SCALE = scaleMatch && Number.isFinite(Number(scaleMatch[1])) ? Number(scaleMatch[1]) : 1;
const scaled = (points) => points.map((p) => p.map((v) => v * SCALE));
const INTERIOR = scaled([[0.15, 0.001, 0.1], [0.6, 0.001, 0.6], [-0.6, 0.001, -0.6], [0.9, 0.001, 0], [-0.998, 1, 0], [0, 1, -0.998], [0, 1.998, 0]]);
const OUTSIDE = scaled([[2.4, 0.001, 0], [0, 0.001, 2.4]]);

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

async function measure(gap) {
  await page.goto(`${base}&gap=${gap}`);
  await page.waitForFunction(() => window.__leak?.stages().includes('resident') === true, null, { timeout: 150000 });
  await page.waitForFunction(() => document.querySelector('#loading-overlay')?.hidden === true, null, { timeout: 120000 }).catch(() => {});
  const sample = await page.evaluate(({ interior, outside }) => {
    const luma = (report) => {
      const v = report?.stages?.resident;
      return v ? 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2] : null;
    };
    const read = (points) => points.map((p) => {
      const report = window.__leak.atWorld(p[0], p[1], p[2]);
      return {
        at: p, metres: report?.metres ?? null, luma: luma(report), chart: report?.chart ?? null,
        texel: report?.texel ?? null, normal: report?.normal ?? null, firstChangedStage: report?.firstChangedStage ?? null,
        chain: report ? Object.entries(report.stages).map(([name, v]) => [name, 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2], v[3]]) : null,
      };
    });
    return { interior: read(interior), outside: read(outside) };
  }, { interior: INTERIOR, outside: OUTSIDE });
  await writeFile(`${out}/gap-${gap}mm-${cam}-${tag}.png`, await page.screenshot());
  const lit = sample.interior.filter((s) => s.luma !== null);
  const mean = lit.length ? lit.reduce((sum, s) => sum + s.luma, 0) / lit.length : null;
  const peak = lit.length ? Math.max(...lit.map((s) => s.luma)) : null;
  const reference = sample.outside.filter((s) => s.luma !== null).map((s) => s.luma);
  return { gap, mean, peak, reference: reference.length ? Math.max(...reference) : null, samples: sample.interior };
}

const runs = [];
for (const gap of gaps) runs.push(await measure(gap));
await browser.close();

for (const run of runs) {
  const where = run.samples.map((s) => `${s.at.join('/')}@${s.metres?.toFixed(3) ?? '-'}m/chart${s.chart ?? '-'}=${s.luma === null ? 'none' : s.luma.toFixed(5)}`).join('  ');
  console.log(`gap ${run.gap} mm: interior mean ${run.mean?.toFixed(5) ?? 'none'}, peak ${run.peak?.toFixed(5) ?? 'none'}, sunlit ground ${run.reference?.toFixed(4) ?? 'none'}`);
  console.log(`  ${where}`);
  const worst = run.samples.filter((s) => s.luma !== null).sort((a, b) => b.luma - a.luma)[0];
  if (worst?.chain) {
    console.log(`  worst interior texel ${worst.texel?.join(',')} chart ${worst.chart} normal ${worst.normal?.map((v) => v.toFixed(2)).join(',')} ${worst.metres.toFixed(3)} m from the probe`);
    console.log(`    ${worst.chain.map(([name, l, alpha]) => `${name}=${l.toFixed(5)}/a${alpha.toFixed(2)}`).join('  ')}`);
  }
}

const sealed = runs.find((run) => run.gap === 0);
const opened = runs.filter((run) => run.gap > 0).sort((a, b) => a.gap - b.gap);
const reference = sealed?.reference ?? 1;
const tolerance = reference * 0.001;
const widest = opened[opened.length - 1];
const sealedDark = sealed !== undefined && sealed.peak !== null && sealed.peak <= tolerance;
const added = (run) => run.mean - (sealed?.mean ?? 0);
const gapLets = widest === undefined || added(widest) >= reference * 0.0005;
const monotone = opened.every((run, i) => i === 0 || added(run) >= added(opened[i - 1]) - reference * 0.0002);
console.log(`sealed peak must stay under ${tolerance.toFixed(5)} (0.1% of the sunlit ground); the widest gap must add ${(reference * 0.0005).toFixed(5)} over the sealed mean, and each wider gap must not add less`);
for (const run of opened) console.log(`  gap ${run.gap} mm adds ${added(run).toFixed(5)} over sealed`);
console.log(`errors ${errors.length}${errors.length ? ': ' + errors.slice(0, 2).join(' | ').slice(0, 300) : ''}`);
console.log(`sealed room dark: ${sealedDark ? 'PASS' : 'FAIL'}; the widest gap still lets light in: ${gapLets ? 'PASS' : 'FAIL'}; light grows with the gap: ${monotone ? 'PASS' : 'FAIL'}`);
process.exit(sealedDark && gapLets && monotone && errors.length === 0 ? 0 : 1);
