import * as THREE from 'three/webgpu';
import { SEAWATER_INDEX_550_NM } from './physicsReference.ts';
import { Discard, Fn, Loop, If, abs, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, clamp, distance, float, materialOpacity, max, min, mix, mrt, normalize, output, positionWorld, refract, select, smoothstep, sqrt, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';

export function apparentWaterPosition(point: THREE.Node, eye: THREE.Node, level: THREE.Node) {
  return Fn(() => {
    const p = vec3(point);
    const camera = vec3(eye);
    const h = max(camera.y.sub(level), 0.02);
    const d = max(float(level).sub(p.y), 0);
    const delta = p.xz.sub(camera.xz);
    const radius = max(delta.length(), 0.0001);
    const lo = float(0).toVar();
    const hi = radius.toVar();
    const s = radius.mul(0.5).toVar();
    Loop(14, () => {
      const r = radius.sub(s);
      const air2 = h.mul(h).add(s.mul(s));
      const water2 = max(d.mul(d).add(r.mul(r)), 0.000001);
      const f = s.div(sqrt(air2)).sub(r.mul(SEAWATER_INDEX_550_NM).div(sqrt(water2)));
      If(f.greaterThan(0), () => hi.assign(s)).Else(() => lo.assign(s));
      s.assign(lo.add(hi).mul(0.5));
    });
    const apparentXZ = camera.xz.add(delta.div(radius).mul(s).mul(h.add(d).div(h)));
    return select(d.lessThan(0.0001), p, vec3(apparentXZ.x, p.y, apparentXZ.y));
  })();
}

export class WaterTransmission {
  readonly target = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, count: 2 });
  readonly viewProjection = uniform(new THREE.Matrix4());
  readonly eye = uniform(new THREE.Vector3());
  readonly levelNode: ReturnType<typeof uniform>;
  readonly camera = new THREE.PerspectiveCamera();
  private readonly size = new THREE.Vector2();
  private readonly bounds = new THREE.Box3();
  private readonly clearColor = new THREE.Color() as ReturnType<THREE.WebGPURenderer['getClearColor']>;
  private readonly materials = new Map<THREE.Material, { material: THREE.NodeMaterial; version: number }>();
  private readonly attachments = mrt({ output, waterPosition: vec4(positionWorld, 1) });

  constructor(readonly level: number) {
    this.levelNode = uniform(level);
    this.target.textures[0].name = 'output';
    this.target.textures[1].name = 'waterPosition';
    this.target.textures[1].minFilter = THREE.NearestFilter;
    this.target.textures[1].magFilter = THREE.NearestFilter;
  }

  private materialFor(source: THREE.Material): THREE.NodeMaterial {
    const cached = this.materials.get(source);
    if (cached?.version === source.version) return cached.material;
    cached?.material.dispose();
    const material = source.clone() as THREE.NodeMaterial;
    if (source instanceof THREE.MeshStandardNodeMaterial) THREE.MeshStandardMaterial.prototype.copy.call(material as unknown as THREE.MeshStandardMaterial, source as unknown as THREE.MeshStandardMaterial);
    if (source instanceof THREE.MeshBasicNodeMaterial) THREE.MeshBasicMaterial.prototype.copy.call(material as unknown as THREE.MeshBasicMaterial, source as unknown as THREE.MeshBasicMaterial);
    const opacity = material.opacityNode ?? materialOpacity;
    material.opacityNode = Fn(() => {
      Discard(positionWorld.y.greaterThan(this.levelNode));
      return opacity;
    })();
    material.setupModelViewProjection = () => cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(apparentWaterPosition(positionWorld, cameraPosition, this.levelNode), 1)));
    const originalKey = material.customProgramCacheKey.bind(material);
    material.customProgramCacheKey = () => `${originalKey()}:waterSnellProjection`;
    this.materials.set(source, { material, version: source.version });
    return material;
  }

  update(renderer: THREE.WebGPURenderer, scene: THREE.Scene, source: THREE.PerspectiveCamera): void {
    if (source.position.y <= this.level + 0.02) return;
    renderer.getDrawingBufferSize(this.size);
    const scale = Math.min(0.75, 1536 / this.size.x);
    this.target.setSize(Math.ceil(this.size.x * scale), Math.ceil(this.size.y * scale));
    const camera = this.camera;
    camera.copy(source, false);
    camera.layers.set(0);
    camera.projectionMatrix.elements[0] /= 1.15;
    camera.projectionMatrix.elements[5] /= 1.15;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    camera.updateMatrixWorld();
    this.eye.value.setFromMatrixPosition(source.matrixWorld);
    this.viewProjection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const target = renderer.getRenderTarget();
    const currentMrt = renderer.getMRT();
    const currentRenderObject = renderer.getRenderObjectFunction();
    const autoClear = renderer.autoClear;
    const background = scene.background;
    const alpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearColor);
    const candidates = new Set<THREE.Object3D>();
    const culling: Array<{ object: THREE.Object3D; value: boolean }> = [];
    const shadows: Array<{ shadow: THREE.LightShadow; value: boolean }> = [];
    scene.updateMatrixWorld();
    scene.traverse(object => {
      const light = object as THREE.DirectionalLight;
      if (light.shadow) { shadows.push({ shadow: light.shadow, value: light.shadow.autoUpdate }); light.shadow.autoUpdate = false; }
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.layers.test(camera.layers) || mesh.userData.giExclude) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      this.bounds.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
      if (this.bounds.min.y > this.level) return;
      candidates.add(mesh);
      culling.push({ object, value: object.frustumCulled });
      object.frustumCulled = false;
    });
    try {
      scene.background = null;
      renderer.setClearColor(0, 0);
      renderer.autoClear = true;
      renderer.setRenderTarget(this.target);
      renderer.setMRT(this.attachments);
      renderer.setRenderObjectFunction((...args) => {
        if (!candidates.has(args[0])) return;
        args[4] = this.materialFor(args[4]);
        renderer.renderObject(...args);
      });
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderObjectFunction(currentRenderObject as Parameters<THREE.WebGPURenderer['setRenderObjectFunction']>[0]);
      renderer.setRenderTarget(target);
      renderer.setMRT(currentMrt);
      renderer.autoClear = autoClear;
      renderer.setClearColor(this.clearColor, alpha);
      scene.background = background;
      for (const { object, value } of culling) object.frustumCulled = value;
      for (const { shadow, value } of shadows) shadow.autoUpdate = value;
    }
  }

  sample(position: THREE.Node, normal: THREE.Node, half: THREE.Node) {
    const p = vec3(position);
    const ray = refract(normalize(p.sub(this.eye)), vec3(normal), 1 / SEAWATER_INDEX_550_NM);
    const project = (point: THREE.Node) => {
      const clip = this.viewProjection.mul(vec4(apparentWaterPosition(point, this.eye, this.levelNode), 1));
      return vec2(clip.x.div(max(clip.w, 0.0001)).mul(0.5).add(0.5), float(0.5).sub(clip.y.div(max(clip.w, 0.0001)).mul(0.5)));
    };
    const surfaceUv = project(vec3(p.x, this.level, p.z));
    const base = texture(this.target.textures[1], clamp(surfaceUv, 0.001, 0.999));
    const travel = distance(p, base.xyz);
    const candidate = p.add(ray.mul(travel));
    const candidateUv = project(candidate);
    const candidatePosition = texture(this.target.textures[1], clamp(candidateUv, 0.001, 0.999));
    const error = distance(candidate, candidatePosition.xyz);
    const edge = min(min(candidateUv.x, candidateUv.y), min(float(1).sub(candidateUv.x), float(1).sub(candidateUv.y)));
    const confidence = smoothstep(0.25, 0.06, error).mul(smoothstep(0, 0.02, edge)).mul(candidatePosition.a).mul(base.a);
    const floorWorld = mix(base.xyz, candidatePosition.xyz, confidence);
    const baseColor = texture(this.target.textures[0], clamp(surfaceUv, 0.001, 0.999));
    const candidateColor = texture(this.target.textures[0], clamp(candidateUv, 0.001, 0.999));
    const color = mix(baseColor.rgb, candidateColor.rgb, confidence);
    const tx = select(ray.x.greaterThan(0), float(half).sub(p.x), float(half).negate().sub(p.x)).div(max(abs(ray.x), 0.0001));
    const tz = select(ray.z.greaterThan(0), float(half).sub(p.z), float(half).negate().sub(p.z)).div(max(abs(ray.z), 0.0001));
    const pathLength = select(base.a.greaterThan(0.5), distance(p, floorWorld), min(abs(tx), abs(tz)).min(10));
    return { floorWorld, pathLength, verticalDepth: max(this.levelNode.sub(floorWorld.y), 0), sceneColor: color.mul(base.a), confidence };
  }

  dispose(): void {
    this.target.dispose();
    for (const { material } of this.materials.values()) material.dispose();
    this.materials.clear();
  }
}
