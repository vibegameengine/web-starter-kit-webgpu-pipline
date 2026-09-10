import * as THREE from 'three/webgpu';
import { Break, Fn, If, Loop, dot, exp, float, mat4, normalize, reflect, refract, select, uint, vec3, vec4 } from 'three/tsl';
import { SEAWATER_INDEX_550_NM } from './physicsReference.ts';
import type { SurfaceRaycaster } from './surfaceRaycaster.ts';
import type { WaterRayScene } from './rayScene.ts';

type Scalar = ReturnType<typeof float>;
type Vector4 = ReturnType<typeof vec4>;

export interface WaveReflectionOptions {
  sampleEnvironment: (direction: THREE.Node, roughness: THREE.Node) => THREE.Node;
  scene: WaterRayScene;
  surface: SurfaceRaycaster;
  half: number;
  absorption: THREE.Node;
  volumeRadiance: THREE.Node;
}

export function waveReflection(options: WaveReflectionOptions, position: THREE.Node, direction: THREE.Node, normal: THREE.Node, roughness: THREE.Node): THREE.Node {
  const { scene, half } = options;
  const traceSurface = (origin: THREE.Node, ray: THREE.Node, distance: THREE.Node) => options.surface.trace(origin, ray, distance) as Vector4;
  return Fn(() => {
    const origin = vec3(position).add(vec3(normal).mul(0.002)).toVar();
    const ray = normalize(direction).toVar();
    const radiance = vec3(0).toVar();
    const throughput = float(1).toVar();
    Loop(16, () => {
      const geometry = mat4(scene.trace({ origin, direction: ray })).toVar();
      const geometryDistance = select((geometry.element(uint(1)) as Vector4).w.greaterThan(0), (geometry.element(uint(0)) as Vector4).w, float(half * 4));
      const boundary = traceSurface(origin, ray, geometryDistance).toVar();
      If(boundary.w.lessThanEqual(0), () => {
        const sky = options.sampleEnvironment(ray, roughness);
        radiance.addAssign(scene.shade(geometry, ray, sky).mul(throughput));
        Break();
      });
      const hitPoint = origin.add(ray.mul(boundary.w)).toVar();
      const hitNormal = normalize(boundary.xyz).toVar();
      const cosine = dot(hitNormal, ray.negate()).clamp(0, 1);
      const transmittedCosine = float(1).sub(float(1).sub(cosine.pow(2)).div(SEAWATER_INDEX_550_NM ** 2)).sqrt();
      const rs = cosine.sub(transmittedCosine.mul(SEAWATER_INDEX_550_NM)).div(cosine.add(transmittedCosine.mul(SEAWATER_INDEX_550_NM)));
      const rp = cosine.mul(SEAWATER_INDEX_550_NM).sub(transmittedCosine).div(cosine.mul(SEAWATER_INDEX_550_NM).add(transmittedCosine));
      const fresnel = rs.pow(2).add(rp.pow(2)).mul(0.5).toVar();
      const transmitted = refract(ray, hitNormal, float(1 / SEAWATER_INDEX_550_NM)).toVar();
      const underOrigin = hitPoint.add(transmitted.mul(0.002));
      const underHit = mat4(scene.trace({ origin: underOrigin, direction: transmitted })).toVar();
      const underDistance = select((underHit.element(uint(1)) as Vector4).w.greaterThan(0), (underHit.element(uint(0)) as Vector4).w, float(half * 4)) as Scalar;
      const attenuation = exp(vec3(options.absorption).mul(underDistance).negate());
      const underRadiance = scene.shade(underHit, transmitted, vec3(0)).mul(attenuation)
        .add(vec3(options.volumeRadiance).mul(vec3(1).sub(attenuation)));
      radiance.addAssign(underRadiance.mul(float(1).sub(fresnel)).mul(throughput));
      throughput.mulAssign(fresnel);
      If(throughput.lessThan(0.00001), () => { Break(); });
      origin.assign(hitPoint.add(hitNormal.mul(0.002)));
      ray.assign(reflect(ray, hitNormal));
    });
    return radiance;
  })();
}
