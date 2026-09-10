import * as THREE from 'three/webgpu';
import { Fn, If, dot, float, mat4, max, mix, normalize, texture, uniform, uint, vec3, vec4, wgslFn } from 'three/tsl';
import { gatherBvhGeometries } from '../../shared/gi/surfel/sceneBvh.ts';
import { createDynamicHierarchy } from '../../shared/gi/surfel/dynamicHierarchy.ts';
import { dynBvhIntersectFirstHit, getDynVertexAttribute } from '../../shared/gi/surfel/dynamicBvh.ts';
import { rayStruct } from '../../shared/gi/bvh/webgpu/index.js';

type V4 = ReturnType<typeof vec4>;
type ColorAtHit = (point: THREE.Node) => THREE.Node;
type RayMaterial = THREE.MeshStandardNodeMaterial | THREE.MeshBasicNodeMaterial;

export class WaterRayScene {
  readonly hierarchy;
  readonly trace;
  readonly sunDirection = uniform(new THREE.Vector3());
  readonly sunRadiance = uniform(new THREE.Color());
  readonly skyIrradiance = uniform(new THREE.Color());
  readonly groundIrradiance = uniform(new THREE.Color());
  readonly materialIds = new Map<string, number>();
  private readonly materials: RayMaterial[] = [];
  private readonly sources;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly sun: THREE.DirectionalLight,
    private readonly hemisphere: THREE.HemisphereLight,
    private readonly colorAtHit = new Map<string, ColorAtHit>(),
  ) {
    const meshes: THREE.Mesh[] = [];
    scene.traverse(object => {
      if (!(object instanceof THREE.Mesh) || !object.layers.isEnabled(0)) return;
      meshes.push(object);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (this.materialIds.has(material.uuid)) continue;
        if (!(material instanceof THREE.MeshStandardNodeMaterial || material instanceof THREE.MeshBasicNodeMaterial)) throw new Error(`Water ray material unsupported: ${material.type}`);
        if (material.colorNode && !colorAtHit.has(material.uuid)) throw new Error(`Water ray color evaluator required: ${material.name || material.uuid}`);
        if (material.alphaTest || material.transparent || ('normalMap' in material && material.normalMap) || material.normalNode || material.positionNode) throw new Error(`Water ray material features require an explicit evaluator: ${material.name || material.uuid}`);
        this.materialIds.set(material.uuid, this.materials.length);
        this.materials.push(material);
      }
    });
    const visibility = meshes.map(mesh => mesh.visible);
    let gathered;
    try {
      meshes.forEach(mesh => { mesh.visible = true; });
      gathered = gatherBvhGeometries(scene, {
        materialIdByUUID: this.materialIds, label: 'water-rays',
        include: mesh => meshes.includes(mesh), triangleBudget: Infinity, farRadius: 0,
      });
    } finally {
      meshes.forEach((mesh, i) => { mesh.visible = visibility[i]; });
    }
    if (gathered.droppedTriangles || gathered.proxiedTriangles) throw new Error('Water ray geometry must retain every triangle');
    this.sources = gathered.entries.map(entry => {
      const source = entry.source;
      const instance = entry.instance;
      const proxy = new THREE.Mesh();
      proxy.matrixAutoUpdate = false;
      proxy.matrixWorld.copy(entry.matrix);
      entry.source = proxy;
      entry.instance = -1;
      return { source, instance, proxy };
    });
    this.hierarchy = createDynamicHierarchy(scene, gathered.entries);
    const hierarchy = this.hierarchy;
    this.trace = wgslFn(`
      fn waterTraceGeometry(origin: vec3f, direction: vec3f) -> mat4x4f {
        var ray: Ray;
        ray.origin = origin;
        ray.direction = direction;
        let hit = dynBvhIntersectFirstHit(ray);
        if (!hit.didHit) { return mat4x4f(vec4f(0.0), vec4f(0.0), vec4f(0.0), vec4f(0.0)); }
        let hitAttribute = getDynVertexAttribute(hit.barycoord, hit.indices.xyz);
        return mat4x4f(vec4f(origin + direction * hit.dist, hit.dist),
          vec4f(hit.normal, 1.0), vec4f(hitAttribute, 0.0), vec4f(hit.barycoord, 0.0));
      }
    `, [rayStruct, dynBvhIntersectFirstHit, getDynVertexAttribute,
      hierarchy.bvhNode, hierarchy.positionNode, hierarchy.indexNode, hierarchy.colorNode] as unknown as NonNullable<Parameters<typeof wgslFn>[1]>);
    this.update();
  }

  update(): void {
    this.scene.updateMatrixWorld(true);
    for (const { source, instance, proxy } of this.sources) {
      let visible = true;
      for (let parent: THREE.Object3D | null = source; parent; parent = parent.parent) visible &&= parent.visible;
      if (!visible) proxy.matrixWorld.makeScale(0, 0, 0);
      else if (instance >= 0) {
        (source as THREE.InstancedMesh).getMatrixAt(instance, proxy.matrixWorld);
        proxy.matrixWorld.premultiply(source.matrixWorld);
      } else proxy.matrixWorld.copy(source.matrixWorld);
    }
    this.hierarchy.refresh();
    this.sunDirection.value.setFromMatrixPosition(this.sun.matrixWorld).sub(new THREE.Vector3().setFromMatrixPosition(this.sun.target.matrixWorld)).normalize();
    this.sunRadiance.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);
    this.skyIrradiance.value.copy(this.hemisphere.color).multiplyScalar(this.hemisphere.intensity);
    this.groundIrradiance.value.copy(this.hemisphere.groundColor).multiplyScalar(this.hemisphere.intensity);
  }

  sample(position: THREE.Node, direction: THREE.Node, surfaceNormal: THREE.Node, sky: THREE.Node): THREE.Node {
    const ray = normalize(direction);
    const hit = this.trace({ origin: vec3(position).add(vec3(surfaceNormal).mul(0.002)), direction: ray }) as ReturnType<typeof mat4>;
    return this.shade(hit, ray, sky);
  }

  shade(intersection: THREE.Node, direction: THREE.Node, sky: THREE.Node): THREE.Node {
    return Fn(() => {
      const ray = normalize(direction);
      const hit = mat4(intersection).toVar();
      const point = vec3((hit.element(uint(0)) as V4).xyz);
      const normal = (hit.element(uint(1)) as V4).xyz;
      const attribute = hit.element(uint(2)) as V4;
      const result = sky.toVar();
      If((hit.element(uint(1)) as V4).w.greaterThan(0.5), () => {
        const shadow = this.trace({ origin: point.add(normal.mul(0.002)), direction: this.sunDirection }) as ReturnType<typeof mat4>;
        const visibility = float(1).sub((shadow.element(uint(1)) as V4).w);
        for (const [id, material] of this.materials.entries()) {
          If(attribute.z.round().equal(float(id)), () => {
            let albedo = vec3(this.colorAtHit.get(material.uuid)?.(point) ?? uniform(material.color));
            if (material.map) albedo = albedo.mul(texture(material.map, attribute.xy).level(float(0)).rgb);
            if (material instanceof THREE.MeshBasicNodeMaterial) {
              result.assign(albedo);
              return;
            }
            const diffuse = albedo.mul(1 - material.metalness).div(Math.PI);
            const view = ray.negate();
            const halfVector = normalize(view.add(this.sunDirection));
            const nl = dot(normal, this.sunDirection).clamp(0, 1);
            const nv = dot(normal, view).clamp(0, 1);
            const nh = dot(normal, halfVector).clamp(0, 1);
            const vh = dot(view, halfVector).clamp(0, 1);
            const alpha2 = float(Math.max(0.0525, material.roughness) ** 4);
            const distribution = alpha2.div(float(1).sub(nh.pow(2).mul(float(1).sub(alpha2))).pow(2).mul(Math.PI));
            const smith = float(0.5).div(max(nl.mul(alpha2.add(float(1).sub(alpha2).mul(nv.pow(2))).sqrt()).add(nv.mul(alpha2.add(float(1).sub(alpha2).mul(nl.pow(2))).sqrt())), 0.000001));
            const f0 = mix(vec3(0.04), albedo, material.metalness);
            const fresnel = f0.add(vec3(1).sub(f0).mul(float(1).sub(vh).pow(5)));
            const direct = diffuse.add(fresnel.mul(distribution).mul(smith)).mul(this.sunRadiance).mul(nl).mul(visibility);
            const ambient = diffuse.mul(mix(this.groundIrradiance, this.skyIrradiance, normal.y.mul(0.5).add(0.5)));
            result.assign(direct.add(ambient).add(vec3(uniform(material.emissive)).mul(material.emissiveIntensity)));
          });
        }
      });
      return result;
    })();
  }

  dispose(renderer: THREE.WebGPURenderer): void { this.hierarchy.dispose(renderer); }
}



