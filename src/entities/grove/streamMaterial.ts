import * as THREE from 'three/webgpu';
import { color, float, mix, mx_fractal_noise_float, normalize, positionWorld, smoothstep, transformNormalToView, uniform, vec3 } from 'three/tsl';

export interface StreamMaterial {
  material: THREE.MeshStandardNodeMaterial;
  update(elapsedSeconds: number): void;
}

const SHALLOW = new THREE.Color(0.16, 0.20, 0.17);
const DEEP = new THREE.Color(0.05, 0.09, 0.10);
const FOAM = new THREE.Color(0.72, 0.76, 0.74);

const RIPPLE_SCALE = 9.0;
const RIPPLE_HEIGHT = 0.035;
const FLOW_METRES_PER_SECOND = 0.55;

function rippleNormal(time: ReturnType<typeof uniform>) {
  const drift = time.mul(FLOW_METRES_PER_SECOND);
  const p = vec3(positionWorld.x.mul(RIPPLE_SCALE), positionWorld.z.mul(RIPPLE_SCALE).add(drift), drift.mul(0.4));
  const step = float(0.35);
  const height = mx_fractal_noise_float(p, 3);
  const dx = mx_fractal_noise_float(p.add(vec3(step, 0, 0)), 3).sub(height);
  const dz = mx_fractal_noise_float(p.add(vec3(0, step, 0)), 3).sub(height);
  return normalize(vec3(dx.mul(RIPPLE_HEIGHT).negate(), 1.0, dz.mul(RIPPLE_HEIGHT).negate()));
}

/**
 * @important The stream is opaque, not a translucent overlay: the frame graph's overlay
 * pass is the beach lagoon's, wired to that scene's screen colour and depth, and a
 * 20 cm brook reads from its surface — ripples, sky reflection, foam at the ledge —
 * not from what is refracted through it.
 */
export function createStreamMaterial(): StreamMaterial {
  const time = uniform(0);
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = 'groveStream';
  material.metalness = 0;
  material.roughness = 0.08;
  material.color = SHALLOW.clone();
  material.side = THREE.DoubleSide;
  material.userData.lightmapAlbedo = true;

  const turbulence = mx_fractal_noise_float(positionWorld.mul(3.0).add(vec3(0, time.mul(0.8), 0)), 3).mul(0.5).add(0.5);
  const churn = smoothstep(0.55, 0.95, turbulence);
  material.colorNode = mix(mix(color(DEEP), color(SHALLOW), turbulence), color(FOAM), churn.mul(0.35));
  material.roughnessNode = mix(float(0.06), float(0.4), churn);
  material.normalNode = transformNormalToView(rippleNormal(time));

  return {
    material,
    update(elapsedSeconds: number): void {
      time.value = elapsedSeconds;
    },
  };
}
