import * as THREE from 'three/webgpu';
import type GUI from 'lil-gui';
import { FrameGraph, GiMode, SplitView, type Antialiasing } from '../../shared/render/index.ts';
import { CacheStats, WorldState, Mobility, applyMobility } from '../../shared/world/index.ts';
import { Hud } from '../../shared/ui/hud.ts';
import { SurfelGI } from '../../shared/gi/index.ts';
import { PROBE_LAYER_INTERIOR, type ProbeVolume } from '../../shared/gi/probes/index.ts';
import { readValidationTexture } from '../../shared/render/gpuReadback.ts';
import { giLightSummary } from '../../shared/gi/surfel/sceneLights.ts';
import { addDynamicDemoObject, type DynamicObject } from '../../shared/gi/surfel/content.ts';
import { hook, readUrlParams, type PipelineUi, type RenderPipeline, type SceneHost, type UrlParams } from './host.ts';
import { setupSun, type SunControls } from './sun.ts';
import { StaticLight } from './staticLight.ts';
import { leakHookApi } from '../../shared/gi/bake/leakStages.ts';
import { TraceStages } from './traceStages.ts';
import { PostStages } from './postStages.ts';
import { gpuPasses } from './audit.ts';
import { LodLab } from '../../widgets/lod-lab/index.ts';
import { bootStage } from '../../shared/ui/bootProgress.ts';

export type { SceneHost, PipelineUi, RenderPipeline } from './host.ts';

const MAX_MOVERS = 64;
const HALF_GBUFFER = 0.5;

export async function createRenderPipeline(renderer: THREE.WebGPURenderer): Promise<RenderPipeline> {
  const gi = await bootStage('Loading GI assets', () => SurfelGI.create(renderer));
  return { gi, envTexture: gi.envTexture, run: (host, gui, runUi) => runPipeline(renderer, gi, host, gui, runUi) };
}

function addMovers(host: SceneHost, url: UrlParams): { movers: DynamicObject[]; update(t: number): void } | null {
  const parked = url.get('moverAt')?.split(',').map(Number);
  const wanted = host.moverByDefault ? url.flag('mover', true) : url.get('mover') === '1' || parked !== undefined;
  if (!wanted) return null;
  if (parked && parked.length === 3 && parked.every(Number.isFinite)) {
    const mover = addDynamicDemoObject(host.scene, { radius: url.num('moverRadius') ?? undefined });
    applyMobility(mover.mesh, Mobility.Movable);
    mover.mesh.position.set(parked[0], parked[1], parked[2]);
    return { movers: [mover], update() { mover.mesh.position.set(parked[0], parked[1], parked[2]); } };
  }
  const count = Math.max(1, Math.min(MAX_MOVERS, Math.floor(url.num('movers') ?? 1)));
  const movers = Array.from({ length: count }, () => {
    const mover = addDynamicDemoObject(host.scene, { radius: url.num('moverRadius') ?? (count > 1 ? 0.22 : undefined) });
    applyMobility(mover.mesh, Mobility.Movable);
    return mover;
  });
  const speed = url.num('moverSpeed') ?? 1;
  return {
    movers,
    update(time) {
      const t = time * speed;
      if (count === 1) { movers[0].update(t); return; }
      movers.forEach((mover, i) => {
        mover.mesh.position.set((i % 4 - 1.5) * 1.25 + Math.sin(t + i) * .15, 3 + Math.floor(i / 4) * .8, 2.8 + Math.sin(t * .7 + i) * .2);
        mover.mesh.rotation.set(t * .3, t * 1.5 + i, 0);
      });
    },
  };
}

function createFrameGraph(renderer: THREE.WebGPURenderer, host: SceneHost, url: UrlParams): FrameGraph {
  const frameGraph = new FrameGraph(renderer, host.scene, host.camera, {
    giMode: (url.get('giMode') as GiMode) ?? GiMode.Combined,
    indirectIntensity: url.num('gi') ?? 1,
    splitView: (url.get('split') as SplitView) ?? SplitView.Off,
    overlay: host.bindScreen !== undefined,
    antialiasing: (['taa', 'fxaa', 'none'] as Antialiasing[]).find((m) => m === url.get('aa')) ?? 'taa',
  });
  if (host.bindScreen) { frameGraph.onScreenTextures = host.bindScreen; frameGraph.forceRebuild(); }
  return frameGraph;
}

interface Pipeline {
  renderer: THREE.WebGPURenderer; gi: SurfelGI; host: SceneHost; url: UrlParams; frameGraph: FrameGraph;
  staticLight: StaticLight; trace: TraceStages; post: PostStages; sun: SunControls; live: { on: boolean }; giScale: () => number;
  dynamic: ReturnType<typeof addMovers>; world: WorldState; stats: CacheStats; hud: Hud | null;
  lab: LodLab | null;
}

function openLodLab(renderer: THREE.WebGPURenderer, staticLight: StaticLight, camera: THREE.PerspectiveCamera, frameGraph: FrameGraph): LodLab | null {
  if (!staticLight.lod) {
    console.warn('[lod-lab] needs ?lod=1');
    return null;
  }
  const lab = new LodLab(renderer, staticLight.lod);
  const guiElement = document.querySelector<HTMLElement>('.lil-gui.root');
  const gutter = guiElement ? guiElement.getBoundingClientRect().width : 0;
  document.documentElement.style.setProperty('--lod-lab-gutter', `${Math.ceil(gutter)}px`);
  document.body.classList.add('lod-lab');
  camera.aspect = (window.innerWidth / 2) / window.innerHeight;
  camera.updateProjectionMatrix();
  frameGraph.setSize(window.innerWidth / 2, window.innerHeight);
  return lab;
}

function bindLightingGui(gui: GUI, p: Pipeline, ui: PipelineUi): void {
  const { frameGraph, gi, staticLight } = p;
  const giFolder = gui.addFolder('GI (live surfels)');
  const giParams = { indirectIntensity: frameGraph.indirectIntensity.value as number };
  giFolder.add(giParams, 'indirectIntensity', 0, 8, 0.05).name('live surfel intensity').onChange((v: number) => { frameGraph.indirectIntensity.value = v; });
  giFolder.add(p.live, 'on').name('live surfels (legacy)').onChange(() => { p.gi.resize(p.renderer, p.giScale()); p.staticLight.setLiveChainServesReceivers(p.live.on); });
  const splitParams = { right: (p.url.get('split') as SplitView) ?? SplitView.Off, at: frameGraph.splitPosition };
  const splitFolder = gui.addFolder('Split view');
  splitFolder.add(splitParams, 'right', Object.values(SplitView)).name('right pane').onChange((v: SplitView) => frameGraph.setSplitView(v));
  splitFolder.add(splitParams, 'at', 0, 1, 0.01).name('divider').onChange((v: number) => { frameGraph.splitPosition = v; frameGraph.forceRebuild(); });
  const lighting = gui.addFolder('Lighting');
  lighting.add(staticLight.atlasParams, 'intensity', 0, 8, 0.05).name('atlas mul').onChange((v: number) => { staticLight.atlasIntensity.value = v; });
  if (staticLight.probes) {
    lighting.add(staticLight.probes.intensity, 'value', 0, 8, 0.05).name('probe mul');
  }
  const bake = gui.addFolder('GI bake');
  bake.add(staticLight.bakeParams, 'passes', 8, 256, 1).name('lightmap passes');
  const bakeState = { status: 'baking' };
  bake.add(bakeState, 'status').name('baked light').listen().disable();
  setInterval(() => { bakeState.status = staticLight.ready ? staticLight.bakeStatusText() : 'baking'; }, 500);
  bake.add({ rebake: () => {
    void staticLight.prepare(frameGraph, { forceBake: true, contactTree: p.trace.buildTree(p.host.scene), interiorVolumes: p.host.interiorVolumes })
      .then(() => ui.clearLoading())
      .catch(ui.showError);
  } }, 'rebake').name('re-bake now');
  const envParams = { env: p.url.num('env') ?? 1, lod: 4 };
  giFolder.add(envParams, 'env', 0, 5, 0.05).name('env').onChange(() => gi.setEnvControls(envParams.env, envParams.lod));
}

function atlasTexelUnderPointer(p: Pipeline, event: MouseEvent): [number, number] | null {
  const leak = p.staticLight.leak;
  if (!leak || p.frameGraph.split !== SplitView.Leak) return null;
  const rect = p.renderer.domElement.getBoundingClientRect();
  const u = (event.clientX - rect.left) / rect.width;
  if (u < p.frameGraph.splitPosition) return null;
  const local = (u - p.frameGraph.splitPosition) / (1 - p.frameGraph.splitPosition);
  const v = (event.clientY - rect.top) / rect.height;
  if (local > 1) return null;
  return [Math.floor(local * leak.size), Math.floor(v * leak.size)];
}

function bindLeakGui(gui: GUI, p: Pipeline): void {
  const leak = p.staticLight.leak;
  if (!leak) return;
  const folder = gui.addFolder('Bake leak');
  const params = { stage: leak.shown, gain: leak.diffGain };
  const stage = folder.add(params, 'stage', leak.options()).name('atlas stage');
  stage.onChange((v: string) => { leak.show(v); p.frameGraph.setSplitView(SplitView.Leak); });
  folder.add(params, 'gain', 1, 64, 1).name('diff gain').onChange((v: number) => { leak.diffGain = v; leak.show(leak.shown); });
  folder.add({ show: () => { stage.options(leak.options()).setValue(leak.shown); p.frameGraph.setSplitView(SplitView.Leak); } }, 'show').name('show in right pane');
  folder.add({ report: () => { console.table(leak.firstChange()); console.table(leak.inventedLight()); } }, 'report').name('first changed stage');
  p.renderer.domElement.addEventListener('click', (event) => {
    const texel = atlasTexelUnderPointer(p, event);
    if (texel) console.log('[leak]', JSON.stringify(leak.inspect(texel[0], texel[1])));
  });
}

function countProbes(volume: ProbeVolume, test: (volume: ProbeVolume, probe: number) => boolean): number {
  let n = 0;
  for (let p = 0; p < volume.count; p++) if (test(volume, p)) n++;
  return n;
}

function installHooks(p: Pipeline, state: { paused: boolean; stepOnce: boolean; frozen: boolean; intervals: number[]; recording: boolean }): void {
  const { renderer, host, frameGraph, sun } = p;
  const { camera, controls } = host;
  hook('__probe', () => ({
    sunPos: host.sun.position.toArray(), sunIntensity: host.sun.intensity, camera: camera.position.toArray(), target: controls.target.toArray(),
    fov: camera.fov, lightCfg: { ...sun.lightCfg }, giLights: giLightSummary(), pipeline: 'render-pipeline',
  }));
  hook('__camera', (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => {
    camera.position.set(px, py, pz); controls.target.set(tx, ty, tz); controls.update(); camera.updateMatrixWorld(); return true;
  });
  installLodHooks(p);
  hook('__gpuPasses', (frames = 60) => gpuPasses(renderer, frames));
  if (p.staticLight.leak) hook('__leak', leakHookApi(p.staticLight.leak, () => frameGraph.setSplitView(SplitView.Leak)));
  hook('__fog', { ...p.post.hooks(), ...p.trace.hooks(frameGraph) });
  hook('__freeze', (t: number) => { p.dynamic?.update(t); state.frozen = true; return true; });
  installAuditHooks(p, state);
}

function installLodHooks(p: Pipeline): void {
  const { renderer, staticLight } = p;
  hook('__lod', () => {
    const lod = staticLight.lod;
    if (!lod) return null;
    return {
      charts: staticLight.layout?.regions.length ?? 0,
      pages: lod.pool.pages.length,
      poolMiB: +(lod.pool.bytes / 1048576).toFixed(2),
      atlasSize: lod.atlas.size,
      resident: lod.atlas.residentCount(),
      usedCells: lod.atlas.usedCells(),
      totalCells: lod.atlas.totalCells(),
      copies: lod.atlas.copiesLastFrame,
      ...lod.plan,
      demands: undefined,
      mips: lod.plan.demands.reduce((counts: Record<number, number>, demand) => {
        counts[demand.mip] = (counts[demand.mip] ?? 0) + 1;
        return counts;
      }, {}),
    };
  });
  hook('__chartLight', (name = 'bench') => {
    const layout = staticLight.layout;
    const pixels = staticLight.atlasPixels;
    if (!layout || !pixels) return null;
    const size = staticLight.atlasSize;
    return layout.placements.flatMap((placement, chart) => {
      if (placement.mesh.name !== name) return [];
      const { x, y, width, height } = placement.region;
      let sum = 0;
      let lit = 0;
      for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) {
          const index = ((y + row) * size + x + column) * 4;
          const value = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
          sum += value;
          if (value > 0.002) lit++;
        }
      }
      return [{ chart, region: placement.region, centre: placement.centre.toArray().map((v) => +v.toFixed(2)),
        mean: +(sum / (width * height)).toFixed(5), litFraction: +(lit / (width * height)).toFixed(2) }];
    });
  });
  hook('__lodChart', (name = 'bench') => {
    const lod = staticLight.lod;
    const layout = staticLight.layout;
    if (!lod || !layout) return null;
    return layout.placements.flatMap((placement, chart) => {
      if (placement.mesh.name !== name) return [];
      return [{
        chart, region: placement.region, lastMip: lod.pool.lastMip(chart),
        centre: placement.centre.toArray().map((v) => +v.toFixed(2)),
        extent: [+placement.extentU.toFixed(2), +placement.extentV.toFixed(2)],
        root: [lod.pool.rootColours[chart * 3], lod.pool.rootColours[chart * 3 + 1], lod.pool.rootColours[chart * 3 + 2]].map((v) => +v.toFixed(5)),
        residentMip: lod.atlas.residentMip(chart),
      }];
    }).slice(0, 8);
  });
  hook('__lodPixels', async (x = 0, y = 0, width = 32, height = 4) => {
    const lod = staticLight.lod;
    if (!lod) return null;
    const pixels = await renderer.readRenderTargetPixelsAsync(lod.atlas.target, x, y, width, height);
    return Array.from(pixels.slice(0, Math.min(pixels.length, 256)));
  });
}

function installAuditHooks(p: Pipeline, state: { paused: boolean; stepOnce: boolean; frozen: boolean; intervals: number[]; recording: boolean }): void {
  const { renderer, gi, frameGraph, staticLight, sun } = p;
  hook('__audit', {
    pipeline: 'render-pipeline',
    bakeCache: () => ({ ...staticLight.bakeCache }),
    bakeStatus: () => ({ ...staticLight.bakeStatus(), provenance: staticLight.currentProvenance() }),
    lighting: () => ({ baked: staticLight.ready, staticFrozen: gi.staticPinned, runtimeFrozen: gi.frozen, live: p.live.on }),
    probes: () => staticLight.probes ? {
      layout: { ...staticLight.probes.layout, min: staticLight.probes.layout.min.toArray() }, count: staticLight.probes.count,
      active: countProbes(staticLight.probes, (v, p) => v.isActive(p)),
      empty: countProbes(staticLight.probes, (v, p) => v.isEmpty(p)),
      interior: countProbes(staticLight.probes, (v, p) => v.layersOf(p) === PROBE_LAYER_INTERIOR),
      layersEnabled: staticLight.probes.layersEnabled.value,
      volumes: staticLight.probes.interiorVolumes.map((box) => [box.min.toArray(), box.max.toArray()]),
      materials: staticLight.probeReceivers, intensity: staticLight.probes.intensity.value, visibility: staticLight.probes.visibilityTest.value,
      live: staticLight.probeLive ? { frames: staticLight.probeLive.frames, invalidations: staticLight.probeLive.invalidations, ...staticLight.probeLive.settings } : null,
    } : null,
    atlasIntensity(value: number) { staticLight.atlasIntensity.value = value; return value; },
    probeIntensity(value: number) { if (staticLight.probes) staticLight.probes.intensity.value = value; return value; },
    pick(ndcX: number, ndcY: number) {
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), p.host.camera);
      const hit = raycaster.intersectObjects(p.host.scene.children, true)[0];
      if (!hit) return null;
      const normal = hit.normal ? hit.normal.clone().transformDirection(hit.object.matrixWorld) : null;
      return {
        name: hit.object.name, distance: +hit.distance.toFixed(4),
        point: hit.point.toArray().map((v) => +v.toFixed(4)),
        normal: normal ? normal.toArray().map((v) => +v.toFixed(3)) : null,
        sunDot: normal ? +normal.dot(p.host.sun.position.clone().normalize()).toFixed(3) : null,
      };
    },
    meshBounds() {
      const box = new THREE.Box3();
      const out: { name: string; min: number[]; max: number[]; side: number; shadow: boolean }[] = [];
      p.host.scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        box.setFromObject(mesh);
        const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material;
        out.push({ name: mesh.name, min: box.min.toArray().map((v) => +v.toFixed(4)), max: box.max.toArray().map((v) => +v.toFixed(4)), side: material.side, shadow: mesh.castShadow });
      });
      return out;
    },
    probeFill(radiance: number) { staticLight.probes?.fillConstant(radiance); },
    probeVisibility(value: boolean) { if (staticLight.probes) staticLight.probes.visibilityTest.value = value ? 1 : 0; },
    sun(azimuthDeg: number, elevationDeg: number, intensity?: number) {
      sun.lightCfg.azimuthDeg = azimuthDeg; sun.lightCfg.elevationDeg = elevationDeg;
      if (typeof intensity === 'number') sun.lightCfg.intensity = intensity;
      sun.updateLightFromAngles();
      return [sun.lightCfg.azimuthDeg, sun.lightCfg.elevationDeg, sun.lightCfg.intensity];
    },
    hideOverlay() { (renderer.inspector as unknown as { domElement: HTMLElement }).domElement.style.display = 'none'; },
    pause(value = true) { state.paused = value; },
    stepFrame() { if (!state.paused) throw new Error('Pause before stepping a frame'); state.stepOnce = true; },
    measure() { state.intervals = []; state.recording = true; },
    stopMeasure() { state.recording = false; return state.intervals.slice(); },
    async read() {
      if (!state.paused) throw new Error('Pause the renderer before coherent buffer readback');
      return {
        base: await readValidationTexture(renderer, frameGraph.scenePass.getTexture('output')),
        normal: await readValidationTexture(renderer, frameGraph.scenePass.getTexture('normal')),
        receivers: await readValidationTexture(renderer, frameGraph.scenePass.getTexture('albedo')),
        composite: { giMode: frameGraph.giMode, indirectIntensity: frameGraph.indirectIntensity.value, hybridReceivers: frameGraph.hybridReceivers.value },
      };
    },
  });
}

function startLoop(p: Pipeline, ui: PipelineUi, state: { paused: boolean; stepOnce: boolean; frozen: boolean; intervals: number[]; recording: boolean; sunSeen: string }): void {
  const { renderer, gi, host, frameGraph, trace, post, world, stats, hud } = p;
  const { scene, camera, controls } = host;
  let previous = performance.now();
  let framesShown = 0;
  let fatal = false;
  window.addEventListener('error', () => { fatal = true; });
  window.addEventListener('unhandledrejection', () => { fatal = true; });
  renderer.setAnimationLoop(() => {
    if (fatal || (state.paused && !state.stepOnce)) return;
    state.stepOnce = false;
    const now = performance.now();
    const dt = (now - previous) / 1000;
    previous = now;
    if (state.recording && state.intervals.length < 100000) state.intervals.push(dt * 1000);
    world.beginFrame(dt);
    controls.update();
    p.sun.updateAnimation();
    camera.updateMatrixWorld();
    frameGraph.beginFrame();
    if (!state.frozen) p.dynamic?.update(now * 0.001);
    if (!post.still) host.update?.(now * 0.001);
    post.fog.update(now);
    if (p.staticLight.probeLive) {
      const sunNow = `${host.sun.intensity.toFixed(4)}|${host.sun.position.x.toFixed(3)}|${host.sun.position.y.toFixed(3)}|${host.sun.position.z.toFixed(3)}`;
      if (sunNow !== state.sunSeen) { if (state.sunSeen) p.staticLight.probeLive.invalidate(); state.sunSeen = sunNow; }
      p.staticLight.probeLive.update(); p.staticLight.probes!.sunScale.value = 0;
    }
    else if (p.staticLight.probes) p.staticLight.probes.sunScale.value = host.sun.intensity / Math.max(1e-3, p.staticLight.probes.bakedSunIntensity);
    gi.updateDynamicScene();
    if (p.live.on) {
      gi.update(renderer, scene, camera);
      frameGraph.setGiTextures(gi.outputTexture, gi.albedoTexture);
    } else {
      frameGraph.setGiTextures(null, null);
    }
    p.staticLight.lod?.update(camera, window.innerHeight);
    trace.update(scene, frameGraph);
    scene.background = host.skyIsBackground ? gi.envTexture : null;
    post.beforeRender(now, dt);
    frameGraph.render();
    frameGraph.endFrame();
    stats.endFrame(world.dt);
    p.lab?.update();
    hud?.update(world.dt);
    if (framesShown < 2 && ++framesShown === 2) ui.clearLoading();
  });
}

async function runPipeline(renderer: THREE.WebGPURenderer, gi: SurfelGI, host: SceneHost, gui: GUI, ui: PipelineUi): Promise<void> {
  const url = readUrlParams();
  const { scene, camera } = host;
  gi.rigidSurfels = url.flag('rigidSurfels', true);
  gi.setLeafTransmit(url.flag('giLeafTransmit', true));
  const sun = setupSun(gui, host, { envTexture: gi.envTexture, blueNoise: gi.blueNoiseTexture }, url);
  const staticLight = new StaticLight(renderer, gi, scene, host.sun, url);
  await staticLight.unwrap();
  const dynamic = addMovers(host, url);
  dynamic?.update(0);
  await bootStage('Building the static BVH', () => gi.buildScene(renderer, scene));
  gi.setDynamicTracing(url.flag('dyntrace', true));
  gi.setEnvControls(url.num('env') ?? 1, 4);
  const frameGraph = await bootStage('Compiling the frame graph', () => createFrameGraph(renderer, host, url));
  const post = new PostStages(renderer, host, gi.envTexture as THREE.DataTexture, frameGraph, url);
  const trace = new TraceStages(renderer, gi, host, url);
  const world = new WorldState();
  const stats = new CacheStats();
  const hud = ui.showChrome ? new Hud(world, stats, () => staticLight.ready ? `atlas ${staticLight.atlasSize}px + probes` : 'baking', () => staticLight.ready ? staticLight.bakeStatusText() : 'baking') : null;
  ui.applySavedSettings?.(gui);
  const contactTree = await bootStage('Building the contact BVH', () => trace.buildTree(scene));
  await staticLight.prepare(frameGraph, { contactTree, interiorVolumes: host.interiorVolumes });
  const live = { on: url.flag('surfelGi', false) };
  if (staticLight.probes && url.flag('probeSpecular', true)) {
    const volume = staticLight.probes;
    frameGraph.setProbeRadiance((worldPosition, direction) => volume.irradianceAt(worldPosition, direction));
  }
  const giScale = () => (live.on ? 1 : (url.num('giScale') ?? HALF_GBUFFER));
  staticLight.setLiveChainServesReceivers(live.on);
  const lab = url.flag('lodLab', false) ? openLodLab(renderer, staticLight, camera, frameGraph) : null;
  const p: Pipeline = { renderer, gi, host, url, frameGraph, staticLight, trace, post, sun, live, dynamic, world, stats, hud, giScale, lab };
  gi.resize(renderer, giScale());
  bindLightingGui(gui, p, ui);
  bindLeakGui(gui, p);
  host.bindGui?.(gui);
  post.bindGui(gui);
  trace.bindGui(gui, frameGraph);
  window.addEventListener('resize', () => {
    const width = lab ? window.innerWidth / 2 : window.innerWidth;
    camera.aspect = width / window.innerHeight;
    camera.updateProjectionMatrix();
    frameGraph.setSize(width, window.innerHeight);
    gi.resize(renderer, p.giScale());
  });
  const state = { paused: false, stepOnce: false, frozen: false, intervals: [] as number[], recording: false, sunSeen: '' };
  const freezeAt = url.num('freezeAt');
  if (freezeAt !== null) { dynamic?.update(freezeAt); state.frozen = true; }
  installHooks(p, state);
  await bootStage('Compiling shaders', async () => {
    const programs = url.flag('warmup', true) ? renderer.compileAsync(scene, camera) : Promise.resolve();
    trace.tree(scene);
    await programs;
  });
  await bootStage('Waiting for the first frame', () => startLoop(p, ui, state));
}
