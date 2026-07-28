// Standalone sandbox scene — vanilla-Three.js port of references/fluffygrass
// (0xca0a's "fairly realistic grass": R3F + lamina). Kept outside the FSD
// layers on purpose: it is a reference playground, not part of Elderwood.
//
// What is ported: perlin-deformed blob, 60k instanced cone strands surface-
// sampled onto it, lamina Depth gradient (dark base → green by distance from
// origin) × WindLayer multiply (white ↔ mint noise), vertex wind sway,
// auto-rotating camera, sunset sky. Flowers/butterflies/particles are not.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { createNoise2D, createNoise3D } from 'simplex-noise';

const STRANDS = 60000;

const container = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.65;
container.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 100);
camera.position.set(1.7, -2.1, 1.7); // same direction as the reference camera, pulled back to frame the whole blob

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableZoom = false;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.8;
controls.enableDamping = true;

// ── sunset sky (stand-in for drei <Sky/> + Environment preset="sunset") ──────
const sky = new Sky();
sky.scale.setScalar(50);
const sunDir = new THREE.Vector3(0.4, 0.12, -1).normalize();
const skyU = sky.material.uniforms;
skyU.sunPosition.value.copy(sunDir);
skyU.turbidity.value = 8;
skyU.rayleigh.value = 2.2;
skyU.mieCoefficient.value = 0.005;
skyU.mieDirectionalG.value = 0.8;
scene.add(sky);

// IBL baked from the same sky — stand-in for <Environment preset="sunset">,
// lights the GLB flowers/butterflies (the grass shader is unlit and unaffected)
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(50);
  for (const k of ['sunPosition', 'turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG'] as const) {
    const u = envSky.material.uniforms[k];
    if (u.value instanceof THREE.Vector3) u.value.copy(skyU[k].value);
    else u.value = skyU[k].value;
  }
  envScene.add(envSky);
  scene.environment = pmrem.fromScene(envScene).texture;
  pmrem.dispose();
}

// ── blob: icosahedron displaced along normals by simplex noise ───────────────
const noise3 = createNoise3D();
const blobGeo = new THREE.IcosahedronGeometry(1.5, 16);
{
  const pos = blobGeo.attributes.position;
  const nor = blobGeo.attributes.normal;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    const s = v.clone().multiplyScalar(0.5);
    v.add(n.multiplyScalar(noise3(s.x, s.y, s.z) * 0.3));
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  blobGeo.computeVertexNormals();
}
// flower "density" weight — perlin patches, exactly as BlobGeometry.jsx computes it
{
  const pos = blobGeo.attributes.position;
  const density = new Float32Array(pos.count);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    let m = THREE.MathUtils.mapLinear(noise3(v.x, v.y, v.z), -1, 1, 0, 1);
    if (m > 0.15) m = 0;
    density[i] = m;
  }
  blobGeo.setAttribute('density', new THREE.BufferAttribute(density, 1));
}
const blob = new THREE.Mesh(blobGeo, new THREE.MeshBasicMaterial({ color: '#221600' }));
scene.add(blob);

// ── grass strand geometry: half-cone, rotated to grow along +Z (0 → 1) ───────
const strandGeo = new THREE.ConeGeometry(0.05, 1.0, 2, 20, false, 0, Math.PI);
strandGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
strandGeo.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, 0.5));

// ── material: Depth gradient × wind-noise tint, wind sway in the vertex stage ─
const GLSL_SNOISE = /* glsl */ `
  vec3 mod289(vec3 x){return x - floor(x * (1.0/289.0)) * 289.0;}
  vec4 mod289(vec4 x){return x - floor(x * (1.0/289.0)) * 289.0;}
  vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
  vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
  float snoise(vec3 v){
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }
`;

const grassMat = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  uniforms: {
    uTime: { value: 0 },
    uSway: { value: 0.5 },
    uLength: { value: 1.2 },
    uNoiseScale: { value: 10.0 },
    uNoiseStrength: { value: 5.0 },
    // lamina <Depth colorA colorB near far mapping="world">
    uDepthColorA: { value: new THREE.Color('#221600') },
    uDepthColorB: { value: new THREE.Color('#ade266') },
    uDepthNear: { value: 0.14 },
    uDepthFar: { value: 1.52 },
    // WindLayer multiply tint
    uWindColorA: { value: new THREE.Color('#ffffff') },
    uWindColorB: { value: new THREE.Color('#acf5ce') },
    uSunDir: { value: sunDir.clone() },
  },
  vertexShader: /* glsl */ `
    uniform float uTime;
    uniform float uSway;
    uniform float uLength;
    varying vec3 vBaseWorld;
    varying vec3 vLocalPos;
    ${GLSL_SNOISE}
    void main() {
      vec3 pos = position;
      // strand root in world space — one noise sample per strand
      vec4 baseGP = modelMatrix * instanceMatrix * vec4(pos.x, pos.y, 0.0, 1.0);
      vBaseWorld = baseGP.xyz;
      vec2 noise = vec2(
        snoise(baseGP.xyz * 0.1 + uTime * 0.5 * uSway),
        snoise(baseGP.xyz * 0.1 + uTime * 0.5 * uSway + vec3(37.2, 11.8, 92.4))
      );
      noise = smoothstep(-1.0, 1.0, noise);
      float swingX = sin(uTime * 2.0 + noise.x * 6.28318) * pow(pos.z, 2.0);
      float swingY = cos(uTime * 2.0 + noise.y * 6.28318) * pow(pos.z, 2.0);
      pos.x += swingX;
      pos.y += swingY;
      pos *= uLength;
      vLocalPos = pos;
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(pos, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uDepthColorA;
    uniform vec3 uDepthColorB;
    uniform float uDepthNear;
    uniform float uDepthFar;
    uniform vec3 uWindColorA;
    uniform vec3 uWindColorB;
    uniform float uNoiseScale;
    uniform float uNoiseStrength;
    uniform vec3 uSunDir;
    varying vec3 vBaseWorld;
    varying vec3 vLocalPos;
    ${GLSL_SNOISE}
    void main() {
      // Depth layer along the blade: dark roots → green tips
      // (lamina near/far 0.14..1.52 spans the blade's local extent)
      float d = length(vLocalPos);
      float t = clamp((d - uDepthNear) / (uDepthFar - uDepthNear), 0.0, 1.0);
      vec3 col = mix(uDepthColorA, uDepthColorB, t);
      // WindLayer (multiply): patchy white ↔ mint tint
      float n = clamp(snoise(vBaseWorld * uNoiseScale) * 0.5 + 0.5, 0.0, 1.0) * uNoiseStrength;
      col *= mix(uWindColorB, uWindColorA, clamp(n, 0.0, 1.0));
      // faint sunset key light (stand-in for the physical env lighting)
      float sun = 0.85 + 0.35 * max(dot(normalize(vBaseWorld), uSunDir), 0.0);
      col *= sun;
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
});

// ── scatter strands over the blob surface (reference Sampler transform) ──────
const grass = new THREE.InstancedMesh(strandGeo, grassMat, STRANDS);
{
  const sampler = new MeshSurfaceSampler(blob).build();
  const dummy = new THREE.Object3D();
  const position = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (let i = 0; i < STRANDS; i++) {
    sampler.sample(position, normal);
    const p = position.clone().multiplyScalar(5);
    const n = noise3(p.x, p.y, p.z);
    dummy.scale.setScalar(THREE.MathUtils.mapLinear(n, -1, 1, 0.3, 1) * 0.1);
    dummy.position.copy(position);
    dummy.lookAt(normal.add(position));
    // reference keeps these odd `Math.random() - 0.5 * (PI * 0.5)` jitters — kept verbatim
    dummy.rotation.y += Math.random() - 0.5 * (Math.PI * 0.5);
    dummy.rotation.z += Math.random() - 0.5 * (Math.PI * 0.5);
    dummy.rotation.x += Math.random() - 0.5 * (Math.PI * 0.5);
    dummy.updateMatrix();
    grass.setMatrixAt(i, dummy.matrix);
  }
  grass.instanceMatrix.needsUpdate = true;
}
scene.add(grass);

// ── flowers: 1000 instances of flower.glb, clustered by the density weight ───
const loader = new GLTFLoader();
loader.load('/fluffygrass/models/flower.glb', (gltf) => {
  let mesh = gltf.scene.getObjectByName('_ndyj_Var10_LOD0') as THREE.Mesh | undefined;
  if (!mesh?.isMesh) gltf.scene.traverse((o) => { if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh; });
  if (!mesh) return;
  const geo = mesh.geometry.clone();
  geo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  geo.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, 0.5));
  const flowers = new THREE.InstancedMesh(geo, mesh.material, 1000);
  const sampler = new MeshSurfaceSampler(blob).setWeightAttribute('density').build();
  const dummy = new THREE.Object3D();
  const position = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (let i = 0; i < 1000; i++) {
    sampler.sample(position, normal);
    dummy.scale.setScalar(Math.random() * 0.0075);
    dummy.position.copy(position);
    dummy.lookAt(normal.add(position));
    dummy.rotation.y += Math.random() - 0.5 * (Math.PI * 0.5);
    dummy.rotation.x += Math.random() - 0.5 * (Math.PI * 0.5);
    dummy.rotation.z += Math.random() - 0.5 * (Math.PI * 0.5);
    dummy.updateMatrix();
    flowers.setMatrixAt(i, dummy.matrix);
  }
  flowers.instanceMatrix.needsUpdate = true;
  scene.add(flowers);
});

// ── butterflies: 15 animated clones orbiting and bobbing around the blob ─────
const noise2 = createNoise2D();
const rf = THREE.MathUtils.randFloat;
const mixers: THREE.AnimationMixer[] = [];
const butterflies: { root: THREE.Group; seed: number }[] = [];
loader.load('/fluffygrass/models/butterfly.glb', (gltf) => {
  for (let i = 0; i < 15; i++) {
    const clone = SkeletonUtils.clone(gltf.scene);
    clone.traverse((o) => { o.frustumCulled = false; });
    const mixer = new THREE.AnimationMixer(clone);
    for (const clip of gltf.animations) {
      const action = mixer.clipAction(clip);
      action.setEffectiveTimeScale(6);
      action.play();
      action.time = Math.random() * clip.duration; // stagger the flapping
    }
    mixers.push(mixer);
    // hierarchy mirrors Butterfly.jsx: orbit/bob root → placement → scale/offset
    const root = new THREE.Group();
    const holder = new THREE.Group();
    holder.position.set(rf(0.5, 0.7), rf(0.5, 0.7), rf(0.5, 0.7));
    holder.scale.setScalar(rf(0.5, 1));
    const inner = new THREE.Group();
    inner.scale.setScalar(0.15);
    inner.rotation.y = Math.PI / 4;
    inner.position.y = rf(-3, 1);
    inner.add(clone);
    holder.add(inner);
    root.add(holder);
    root.rotation.y = Math.random() * 100;
    scene.add(root);
    butterflies.push({ root, seed: Math.random() * 100 });
  }
});

// ── loop ─────────────────────────────────────────────────────────────────────
let frames = 0;
let last = performance.now();
const perf = { fps: 0 };
Object.assign(window, { __perf: perf });
const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  grassMat.uniforms.uTime.value += 0.005; // reference: windLayer.time += 0.005/frame
  const dt = clock.getDelta();
  const t = clock.elapsedTime;
  for (const mixer of mixers) mixer.update(dt);
  for (const b of butterflies) {
    b.root.position.y = noise2(t * 0.25, b.seed) * 0.5; // FBM bob from the reference
    b.root.rotation.y -= dt;
  }
  controls.update();
  renderer.render(scene, camera);
  frames++;
  const now = performance.now();
  if (now - last >= 1000) {
    perf.fps = Math.round((frames * 1000) / (now - last));
    frames = 0;
    last = now;
  }
});

window.addEventListener('resize', () => {
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
});
