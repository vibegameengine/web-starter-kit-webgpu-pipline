/* @important Section 01 of public/bake-light-leaks-design.html: before any algorithm is changed, the
   first stage that introduces false light has to be named. ?leak=1 captures the atlas after every
   bake stage; this reads where texels move and where a stage lights a texel the previous stage
   measured as black. The mutation is ?leakMutation=denoiseAll, which drops the denoise plane/normal
   test: its invented-light count must rise, or the capture is not reading the stage it claims to.
   The capture is installed the moment the recorder exists, so it still reports when a later stage
   of the bake throws - which is what a diagnostic is for. Headed, per the project rule.
   Exit 3 = the capture passed but the bake could not finish for an unrelated reason. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

setTimeout(() => { console.error('gate: 4 minutes, abort'); process.exit(2); }, 240000);
const out = 'shots/bake-leak';
await mkdir(out, { recursive: true });
const scene = process.argv[2] ?? 'corridor';
const cam = process.argv[3] ?? 'floor';
const sceneQuery = scene === 'default' ? '' : `&scene=${scene}`;
const base = `http://127.0.0.1:5188/?cam=${cam}${sceneQuery}&leak=1&split=leak&hud=0&inspector=0&still=1&aa=none&grain=0&exposure=1`;

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
let errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const settle = (n) => page.evaluate((f) => new Promise((r) => { let i = 0; const g = () => (++i >= f ? r() : requestAnimationFrame(g)); requestAnimationFrame(g); }), n);

async function boot(query) {
  errors = [];
  await page.goto(base + query);
  await page.waitForFunction(() => window.__leak?.stages().length >= 3, null, { timeout: 120000 });
  const complete = await page.waitForFunction(() => window.__leak?.stages().includes('resident') === true, null, { timeout: 30000 }).then(() => true, () => false);
  if (complete) await page.waitForFunction(() => document.querySelector('#loading-overlay')?.hidden === true, null, { timeout: 120000 }).catch(() => console.log('  the loader never cleared; the pane shots show the overlay'));
  if (complete) await settle(30);
  const report = await page.evaluate(() => (window.__leak ? {
    stages: window.__leak.stages(),
    slots: window.__leak.slots(),
    changes: window.__leak.firstChange(),
    invented: window.__leak.inventedLight(),
  } : null));
  if (!report) throw new Error('the page dropped __leak between the capture and the read');
  return { complete, ...report };
}

async function shootStages(names, tag) {
  for (const name of names) {
    if (!await page.evaluate((n) => window.__leak.show(n), name)) continue;
    await settle(6);
    await writeFile(`${out}/${tag}-${name.replace(/[^a-z0-9]+/gi, '-')}.png`, await page.screenshot());
  }
}

const run = await boot('');
console.log(`stages: ${run.stages.join(' -> ')} over ${run.slots} charted texels; bake finished: ${run.complete}`);
for (const change of run.changes) {
  const where = change.world ? change.world.map((v) => v.toFixed(2)).join(',') : 'no g-buffer';
  console.log(`  ${change.from} -> ${change.to}: ${change.changed} texels moved, max ${change.maxDelta} at texel ${change.at.join(',')} chart ${change.chart} world ${where}`);
}
for (const stage of run.invented) {
  const worst = stage.worst?.world ? ` brightest at texel ${stage.worst.texel.join(',')} chart ${stage.worst.chart} world ${stage.worst.world.map((v) => v.toFixed(2)).join(',')}` : '';
  console.log(`  ${stage.stage} lit ${stage.count} texels the previous stage had measured black, demoted ${stage.overwrittenMeasured} measured texels;${worst || ' no lit texel'}`);
}
if (run.complete) await shootStages([...run.stages, `diff:${run.stages[run.stages.length - 1]}`], 'run');
const runErrors = errors.slice();

const mutated = await boot('&leakMutation=denoiseAll');
const denoiseStages = run.stages.filter((name) => name.startsWith('denoise'));
const inventedIn = (report) => denoiseStages.reduce((n, name) => n + (report.invented.find((s) => s.stage === name)?.count ?? 0), 0);
const movedIn = (report) => denoiseStages.reduce((n, name) => n + (report.changes.find((c) => c.to === name)?.changed ?? 0), 0);
if (mutated.complete) await shootStages(denoiseStages, 'mutated');
await browser.close();

const captured = run.stages.length >= 3 && run.changes.length === run.stages.length - 1;
const mutationBites = inventedIn(mutated) > inventedIn(run) || movedIn(mutated) > movedIn(run);
console.log(`denoise: ${movedIn(run)} texels moved / ${inventedIn(run)} invented; with the surface test removed ${movedIn(mutated)} / ${inventedIn(mutated)}`);
console.log(`errors ${runErrors.length}${runErrors.length ? ': ' + runErrors.slice(0, 2).join(' | ').slice(0, 300) : ''}`);
console.log(`stages captured: ${captured ? 'PASS' : 'FAIL'}; denoise mutation changes the capture: ${mutationBites ? 'PASS' : 'FAIL'}; bake finished: ${run.complete ? 'PASS' : 'BLOCKED'}`);
if (!captured || !mutationBites) process.exit(1);
process.exit(run.complete ? 0 : 3);
