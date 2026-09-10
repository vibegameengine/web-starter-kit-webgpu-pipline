import * as THREE from 'three/webgpu';
import { clamp, distance, float, getViewPosition, max, min, mix, select, smoothstep, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';

export class WaterReflection {
  readonly target = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType });
  readonly enabled = uniform(1);
  readonly distortion = uniform(1);
  readonly viewProjection = uniform(new THREE.Matrix4());
  readonly inverseProjection = uniform(new THREE.Matrix4());
  readonly cameraWorld = uniform(new THREE.Matrix4());
  readonly camera = new THREE.PerspectiveCamera();
  resolutionScale = 0.5;
  private readonly size = new THREE.Vector2();
  private readonly forward = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly plane = new THREE.Plane();
  private readonly clip = new THREE.Vector4();
  private readonly corner = new THREE.Vector4();
  private readonly clearColor = new THREE.Color() as ReturnType<THREE.WebGPURenderer['getClearColor']>;

  constructor(readonly level: number) {
    this.target.texture.name = 'water.reflection';
    this.target.texture.generateMipmaps = true;
    this.target.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.target.depthTexture = new THREE.DepthTexture(1, 1);
    this.target.depthTexture.name = 'water.reflectionDepth';
  }

  update(renderer: THREE.WebGPURenderer, scene: THREE.Scene, source: THREE.PerspectiveCamera): void {
    if (this.enabled.value === 0 || source.position.y <= this.level + 0.01) return;
    renderer.getDrawingBufferSize(this.size);
    const scale = Math.min(this.resolutionScale, 1024 / this.size.x);
    this.target.setSize(Math.max(1, Math.ceil(this.size.x * scale)), Math.max(1, Math.ceil(this.size.y * scale)));
    const camera = this.camera;
    source.updateMatrixWorld();
    camera.copy(source, false);
    camera.layers.set(0);
    camera.position.setFromMatrixPosition(source.matrixWorld);
    camera.position.y = 2 * this.level - camera.position.y;
    source.getWorldDirection(this.forward);
    this.forward.y *= -1;
    this.up.set(0, 1, 0).transformDirection(source.matrixWorld);
    this.up.y *= -1;
    camera.up.copy(this.up);
    camera.lookAt(this.look.copy(camera.position).add(this.forward));
    camera.updateMatrixWorld();
    camera.projectionMatrix.copy(source.projectionMatrix);
    camera.projectionMatrix.elements[0] /= 1.15;
    camera.projectionMatrix.elements[5] /= 1.15;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    this.plane.set(new THREE.Vector3(0, 1, 0), -this.level).applyMatrix4(camera.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    this.corner.set(Math.sign(this.clip.x), Math.sign(this.clip.y), 1, 1).applyMatrix4(camera.projectionMatrixInverse);
    this.clip.multiplyScalar(1 / this.clip.dot(this.corner));
    const projection = camera.projectionMatrix.elements;
    projection[2] = this.clip.x;
    projection[6] = this.clip.y;
    projection[10] = this.clip.z;
    projection[14] = this.clip.w;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    this.viewProjection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.inverseProjection.value.copy(camera.projectionMatrixInverse);
    this.cameraWorld.value.copy(camera.matrixWorld);
    const target = renderer.getRenderTarget();
    const mrt = renderer.getMRT();
    const autoClear = renderer.autoClear;
    const shadows: Array<{ shadow: THREE.LightShadow; autoUpdate: boolean }> = [];
    scene.traverse(object => { const light = object as THREE.DirectionalLight; if (light.shadow) shadows.push({ shadow: light.shadow, autoUpdate: light.shadow.autoUpdate }); });
    const background = scene.background;
    const clearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearColor);
    try {
      scene.background = null;
      renderer.setClearColor(0, 0);
      renderer.autoClear = true;
      for (const { shadow } of shadows) shadow.autoUpdate = false;
      renderer.setMRT(null);
      renderer.setRenderTarget(this.target);
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(target);
      renderer.setMRT(mrt);
      renderer.autoClear = autoClear;
      for (const { shadow, autoUpdate } of shadows) shadow.autoUpdate = autoUpdate;
      renderer.setClearColor(this.clearColor, clearAlpha);
      scene.background = background;
    }
  }

  sample(position: THREE.Node, direction: THREE.Node, sky: THREE.Node) {
    const p = position as ReturnType<typeof vec3>;
    const ray = direction as ReturnType<typeof vec3>;
    const project = (point: THREE.Node) => {
      const clip = this.viewProjection.mul(vec4(point, 1));
      const ndc = clip.xy.div(max(clip.w, 0.0001));
      return vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)));
    };
    const baseUv = project(vec3(p.x, this.level, p.z));
    const baseDepth = texture(this.target.depthTexture!, clamp(baseUv, 0, 1)).r;
    const baseHit = this.cameraWorld.mul(vec4(getViewPosition(baseUv, baseDepth, this.inverseProjection), 1)).xyz;
    const travel = select(baseDepth.lessThan(0.9999), min(distance(p, baseHit), 12), float(4));
    const distortedUv = project(p.add(ray.mul(travel)));
    const uv = mix(baseUv, distortedUv, this.distortion);
    const edge = min(min(uv.x, uv.y), min(float(1).sub(uv.x), float(1).sub(uv.y)));
    const inside = smoothstep(0, 0.025, edge).mul(this.enabled);
    const reflected = texture(this.target.texture, clamp(uv, 0.001, 0.999)).level(float(0.5));
    return mix(sky as ReturnType<typeof vec3>, reflected.rgb, reflected.a.mul(inside));
  }

  dispose(): void { this.target.dispose(); }
}
