import type * as THREE from 'three/webgpu';
import { Fn, If, Loop, dot, exp, float, mat4, max, min, normalize, refract, select, uint, vec3, vec4 } from 'three/tsl';
import { SEAWATER_INDEX_550_NM } from './physicsReference.ts';
import type { SurfaceRaycaster } from './surfaceRaycaster.ts';
import type { WaterRayScene } from './rayScene.ts';

export interface VolumeLightOptions {
  scene: WaterRayScene;
  surface: SurfaceRaycaster;
  half: number;
  absorption: THREE.Node;
  scattering: THREE.Node;
  sunDirection: THREE.Node;
  sunIrradiance: THREE.Node;
}

export function waterSolarScatter(options: VolumeLightOptions, point: THREE.Node, view: THREE.Node, normal: THREE.Node): THREE.Node {
  return Fn(() => {
    const sun = normalize(options.sunDirection);
    const radiance = vec3(0).toVar();
    If(sun.y.greaterThan(0), () => {
      const ray = refract(normalize(view), normalize(normal), float(1 / SEAWATER_INDEX_550_NM)).toVar();
      const origin = vec3(point).add(ray.mul(0.004)).toVar();
      const geometry = mat4(options.scene.trace({ origin, direction: ray })).toVar();
      const distance = min(select((geometry.element(uint(1)) as ReturnType<typeof vec4>).w.greaterThan(0),
        (geometry.element(uint(0)) as ReturnType<typeof vec4>).w, float(60)), 60).toVar();
      const exit = vec4(options.surface.trace(origin, ray, distance)).toVar();
      If(exit.w.greaterThan(0), () => { distance.assign(min(distance, exit.w)); });
      const extinction = vec3(options.absorption).add(options.scattering).toVar();
      Loop(6, ({ i }) => {
        const start = float(i).div(6).pow(2).mul(distance);
        const end = float(i).add(1).div(6).pow(2).mul(distance);
        const sample = origin.add(ray.mul(start.add(end).mul(0.5))).toVar();
        const lightNormal = vec3(0, 1, 0).toVar();
        const lightRay = vec3(0, 1, 0).toVar();
        const entry = vec4(0).toVar();
        Loop(3, () => {
          lightRay.assign(refract(sun.negate(), lightNormal, float(1 / SEAWATER_INDEX_550_NM)).negate());
          entry.assign(options.surface.trace(sample, lightRay, float(options.half * 4)));
          If(entry.w.greaterThan(0), () => { lightNormal.assign(entry.xyz.negate()); });
        });
        If(entry.w.greaterThan(0), () => {
          const blocker = mat4(options.scene.trace({ origin: sample, direction: lightRay })).toVar();
          const shadowed = (blocker.element(uint(1)) as ReturnType<typeof vec4>).w.greaterThan(0)
            .and((blocker.element(uint(0)) as ReturnType<typeof vec4>).w.lessThan(entry.w));
          If(shadowed.not(), () => {
            const airCos = dot(lightNormal, sun).clamp(0, 1);
            const waterCos = dot(lightNormal, lightRay).clamp(0.001, 1);
            const rs = airCos.sub(waterCos.mul(SEAWATER_INDEX_550_NM)).div(max(airCos.add(waterCos.mul(SEAWATER_INDEX_550_NM)), 1e-6));
            const rp = airCos.mul(SEAWATER_INDEX_550_NM).sub(waterCos).div(max(airCos.mul(SEAWATER_INDEX_550_NM).add(waterCos), 1e-6));
            const transmission = float(1).sub(rs.pow(2).add(rp.pow(2)).mul(0.5)).mul(airCos.div(waterCos));
            const cosine = dot(ray, lightRay).clamp(-1, 1);
            const phase = float((1 - 0.924 ** 2) / (4 * Math.PI)).div(float(1 + 0.924 ** 2).sub(cosine.mul(2 * 0.924)).pow(1.5));
            const light = vec3(options.sunIrradiance).mul(exp(extinction.mul(entry.w).negate())).mul(transmission);
            const weight = exp(extinction.mul(start).negate()).sub(exp(extinction.mul(end).negate())).div(max(extinction, vec3(1e-6)));
            radiance.addAssign(light.mul(options.scattering).mul(phase).mul(weight).div(SEAWATER_INDEX_550_NM ** 2));
          });
        });
      });
    });
    return radiance;
  })();
}
