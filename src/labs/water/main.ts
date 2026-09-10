import * as THREE from 'three/webgpu';
import { float, mrt, normalView, output, positionWorld, texture, vec3, vec4, floor, mod, mix, exp } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { createWater } from '../../entities/water/physicalWater.ts';
import { IslandField } from '../../entities/island/heightField.ts';
import { bakeBathymetry } from '../../entities/water/bathymetry.ts';
import { WaterRayScene } from '../../entities/water/rayScene.ts';

class PoolField extends IslandField {
  override height(x: number, _z: number): number { return -1.25 + Math.max(0, x - 2.5) * 0.6; }
}

class OceanField extends IslandField {
  override height(_x: number, _z: number): number { return -30; }
}

async function boot() {
  const started = performance.now();
  const bootTimings: Record<string, number> = { moduleReady: started };
  const checkpoint = (name: string) => { bootTimings[name] = performance.now(); };
  const params = new URLSearchParams(location.search);
  const ocean = params.get('scene') === 'ocean';
  const renderer = new THREE.WebGPURenderer({ antialias: false, trackTimestamp: true });
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  await renderer.init();
  checkpoint('rendererReady');
  document.body.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.05, ocean ? 1000 : 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.maxPolarAngle = Math.PI * 0.495;
  const views: Record<string, number[]> = {
    'Общий': [7, 6, 9, 0, 0, 0],
    'Мяч': [2.6, 2.2, 4.5, 0, 0.1, 0],
    'Сверху': [0.1, 10, 2, 0, 0, 0],
    'У воды': [0, 0.65, 5, 0, 0.2, -1],
    'Обратный': [-6, 4, -7, 0, 0, 0],
  };
  if (ocean) Object.assign(views, {
    'Общий': [26, 9, 38, 0, 0, 0],
    'Мяч': [4, 2, 6, 0, 0.2, 0],
    'Сверху': [0.1, 48, 16, 0, 0, 0],
    'У воды': [0, 1.3, 16, 0, 0.9, -50],
    'Обратный': [-20, 8, -26, 0, 0, 0],
  });
  const pose = (values: number[]) => {
    camera.position.fromArray(values);
    controls.target.fromArray(values, 3);
    controls.update();
    camera.updateMatrixWorld();
    sessionStorage.setItem(`water-lab-camera-${ocean}`, JSON.stringify(values));
  };
  const savedPose = sessionStorage.getItem(`water-lab-camera-${ocean}`);
  pose(savedPose ? JSON.parse(savedPose) as number[] : views['Общий']);
  for (const [label, values] of Object.entries(views)) {
    const button = document.createElement('button');
    button.textContent = label;
    button.onclick = () => pose(values);
    document.querySelector('#views')!.append(button);
  }
  const environment = await new HDRLoader().loadAsync('/exr/pizzo_pernice_puresky_2k.hdr');
  checkpoint('environmentLoaded');
  environment.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = environment;
  const hemisphere = new THREE.HemisphereLight(0xd7edff, 0x776748, 2);
  scene.add(hemisphere);
  const sun = new THREE.DirectionalLight(0xfff0dc, 3);
  sun.position.set(-3, 9, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 0.1, far: 30 });
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun, sun.target);
  const field = ocean ? new OceanField(7, 150, -32) : new PoolField(7, 5, -2);
  const bedGeometry = new THREE.PlaneGeometry(2 * field.half, 2 * field.half, 64, 64);
  bedGeometry.rotateX(-Math.PI / 2);
  const positions = bedGeometry.attributes.position;
  for (let i = 0; i < positions.count; i++) positions.setY(i, field.height(positions.getX(i), positions.getZ(i)));
  bedGeometry.computeVertexNormals();
  const sand = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  const sandColor = (point: THREE.Node) => ocean
    ? vec3(0.38, 0.27, 0.14).mul(exp(vec3(0.32, 0.1, 0.055).mul(point.y.min(0).div(sun.position.clone().normalize().y))))
    : mix(vec3(0.38, 0.27, 0.14), vec3(0.6, 0.46, 0.26), mod(floor(point.x.mul(2)).add(floor(point.z.mul(2))), 2));
  sand.colorNode = sandColor(vec3(positionWorld));
  const bed = new THREE.Mesh(bedGeometry, sand);
  bed.receiveShadow = true;
  scene.add(bed);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.45, 40, 24), new THREE.MeshStandardNodeMaterial({ color: 0xffc629, roughness: 0.25 }));
  ball.position.set(0, 0.46, 0);
  ball.name = 'floating-ball';
  ball.castShadow = true;
  scene.add(ball);
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.8, 0.5), new THREE.MeshStandardNodeMaterial({ color: 0xd93b28 }));
  post.position.set(-1.6, 0.3, -1.8);
  post.castShadow = true;
  scene.add(post);
  const submerged = new THREE.Mesh(new THREE.IcosahedronGeometry(0.65, 1), new THREE.MeshStandardNodeMaterial({ color: 0x185857 }));
  submerged.position.set(1.1, -0.8, 0.8);
  submerged.scale.y = 0.55;
  scene.add(submerged);
  if (ocean) {
    post.visible = false;
    submerged.position.y = -29;
  }
  const probe = new THREE.Mesh(new THREE.SphereGeometry(0.06, 24, 16), new THREE.MeshBasicNodeMaterial({ color: 0xff00ff }));
  probe.name = 'optics-calibration-probe';
  probe.visible = false;
  scene.add(probe);
  checkpoint('sceneBuilt');
  const rayScene = new WaterRayScene(scene, sun, hemisphere, new Map([[sand.uuid, sandColor]]));
  checkpoint('geometryAccelerationBuilt');
  const bathymetry = bakeBathymetry({ renderer, objects: ocean ? [bed] : [bed, post, submerged], half: field.half, size: 256 });
  checkpoint('bathymetrySubmitted');
  const water = createWater({ renderer, field, environment, sun, bathymetry, rayScene, offThread: true,
    spectrum: ocean ? { windSpeed: 8, fetch: 18000, referenceDepth: 30, minWavelength: 1.2, components: 96 } : undefined,
    maximumWaveHeight: ocean ? 2.5 : undefined,
  });
  checkpoint('waterConstructed');
  if (ocean) {
    (water.uniforms.absorb.value as THREE.Vector3).set(0.32, 0.1, 0.055);
    (water.uniforms.scatter.value as THREE.Color).setRGB(0.009, 0.032, 0.045);
    water.uniforms.causticStrength.value = 0;
    water.group.children.filter(object => object.name.startsWith('waterCut')).forEach(object => { object.visible = false; });
  }
  water.group.traverse(o => o.layers.set(1));
  scene.add(water.group);
  const opaque = new THREE.RenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, count: 2 });
  opaque.textures[0].name = 'output';
  opaque.textures[1].name = 'normal';
  opaque.depthTexture = new THREE.DepthTexture(innerWidth, innerHeight);
  const overlay = new THREE.RenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType });
  const opaqueMrt = mrt({ output, normal: vec4(normalView, 0) });
  water.bindScreen(opaque.textures[0], opaque.depthTexture, opaque.textures[1]);
  checkpoint('materialsBound');
  const composite = new THREE.PostProcessing(renderer);
  const waterColor = texture(overlay.texture);
  composite.outputNode = vec4(texture(opaque.textures[0]).rgb.mul(float(1).sub(waterColor.a)).add(waterColor.rgb), 1);
  let moving = params.get('still') !== '1';
  let waterVisible = true;
  const setMoving = (value: boolean) => { moving = value; water.setRunning(value && waterVisible); };
  const setWaterVisible = (value: boolean) => { waterVisible = value; water.group.visible = value; water.setRunning(value && moving); };
  document.querySelector<HTMLButtonElement>('#motion')!.onclick = (event) => {
    setMoving(!moving);
    (event.target as HTMLButtonElement).textContent = moving ? 'Остановить движение' : 'Включить движение';
  };
  await water.ready;
  checkpoint('firstSimulationField');
  water.update(0);
  checkpoint('surfaceSubmitted');
  let elapsed = 0;
  let previous = performance.now();
  const timings: number[] = [];
  let pendingTiming = false;
  let pendingSurface = false;
  let surfaceHeight = 0;
  let gpuMs = 0;
  const status = document.querySelector('#status')!;
  if (params.get('hud') === '0') document.querySelector<HTMLElement>('#panel')!.hidden = true;
  const beauty = composite.outputNode;
  const debug = (view: string) => {
    composite.outputNode = view === 'transmission' ? texture(water.transmission.target.textures[0]) : view === 'reflection' ? texture(water.reflection.target.texture) : view === 'opaque' ? texture(opaque.textures[0]) : beauty;
    composite.needsUpdate = true;
  };
  const api = { renderer, scene, camera, controls, water, rayScene, ball, post, submerged, probe, pose, views, debug, timings, bootTimings, ready: true, bootMs: performance.now() - started, moving: setMoving, waterVisible: setWaterVisible, gpuMs: () => gpuMs,
    gpuBreakdown: () => ({ render: renderer.info.render.timestamp, compute: renderer.info.compute.timestamp }) };
  Object.assign(window, { __waterLab: api });
  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    opaque.setSize(innerWidth, innerHeight);
    overlay.setSize(innerWidth, innerHeight);
  });
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - previous) / 1000, 0.05);
    previous = now;
    if (moving && waterVisible) {
      elapsed += dt;
      water.update(elapsed);
      if (!pendingSurface) {
        pendingSurface = true;
        void water.fields.sampleSurface(ball.position.x, ball.position.z).then(sample => {
          surfaceHeight = sample.eta;
        }).finally(() => { pendingSurface = false; });
      }
      ball.position.y += (surfaceHeight + 0.3 - ball.position.y) * (1 - Math.exp(-dt * 12));
    }
    controls.update();
    if (waterVisible) {
      rayScene.update();
      water.renderReflections(camera);
      water.reflection.update(renderer, scene, camera);
      water.transmission.update(renderer, scene, camera);
    }
    camera.layers.set(0);
    renderer.setRenderTarget(opaque);
    renderer.setMRT(opaqueMrt);
    renderer.render(scene, camera);
    const background = scene.background;
    scene.background = null;
    renderer.setClearColor(0, 0);
    camera.layers.set(1);
    renderer.setRenderTarget(overlay);
    renderer.setMRT(null);
    renderer.render(scene, camera);
    scene.background = background;
    camera.layers.set(0);
    renderer.setRenderTarget(null);
    composite.render();
    if (!bootTimings.firstFrameSubmitted) {
      checkpoint('firstFrameSubmitted');
      void (renderer.backend as unknown as { device: GPUDevice }).device.queue.onSubmittedWorkDone().then(() => checkpoint('firstFrameComplete'));
    }
    if (!pendingTiming) {
      pendingTiming = true;
      void Promise.all([renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER), renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE)]).then(() => {
        gpuMs = renderer.info.render.timestamp + renderer.info.compute.timestamp;
        timings.push(gpuMs);
        if (timings.length > 300) timings.shift();
        pendingTiming = false;
      });
    }
    if (Math.floor(now / 500) !== Math.floor((now - dt * 1000) / 500)) status.textContent = `WebGPU · ${gpuMs.toFixed(2)} мс GPU · первый кадр ${((bootTimings.firstFrameComplete ?? now) / 1000).toFixed(1)} с`;
  });
}

void boot().catch(error => {
  document.querySelector('#status')!.textContent = String(error);
  console.error(error);
});


