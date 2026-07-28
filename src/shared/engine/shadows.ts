import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';

/**
 * ShadowSystem — cascaded shadow maps (the browser-realistic take on UE's
 * virtualized shadow maps): N cascades fitted to the view frustum with a
 * practical split, per-cascade texel-scaled biases (kills peter-panning
 * without acne), soft Poisson filtering from softShadows.ts, and cascade
 * fading. Every lit material must pass through applyTo().
 */
export interface ShadowSystemOpts {
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  /** normalized direction TOWARD the sun */
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  intensity: number;
  cascades?: number;
  shadowMapSize?: number;
  maxFar?: number;
  /** sun softness: 1 = physical solar disc (0.53°), 3 ≈ UE default feel */
  sunSoftness?: number;
}

export class ShadowSystem {
  readonly csm: CSM;
  private sunSoftness: number;

  constructor(opts: ShadowSystemOpts) {
    this.sunSoftness = opts.sunSoftness ?? 3;

    this.csm = new CSM({
      camera: opts.camera,
      parent: opts.scene,
      cascades: opts.cascades ?? 3,
      shadowMapSize: opts.shadowMapSize ?? 2048,
      maxFar: opts.maxFar ?? 250,
      mode: 'practical',
      lightDirection: opts.sunDir.clone().negate().normalize(),
      lightIntensity: opts.intensity,
      lightNear: 1,
      lightFar: 400,
      lightMargin: 100,
      shadowBias: 0,
    });
    this.csm.fade = true;

    for (const light of this.csm.lights) {
      light.color.copy(opts.sunColor);
    }
    this.update();
  }

  /** Register a lit material with the cascade shader. */
  applyTo(material: THREE.Material): void {
    this.csm.setupMaterial(material);
  }

  /** Call every frame (after camera moves) and after parameter changes. */
  update(): void {
    this.csm.update();
    // per-cascade biases scaled by that cascade's world texel size:
    // normal offset ≈ 1.2 texels hugs contacts, depth bias stays tiny.
    for (const light of this.csm.lights) {
      const cam = light.shadow.camera;
      const texelWorld = (cam.right - cam.left) / light.shadow.mapSize.width;
      const depthRange = cam.far - cam.near;
      light.shadow.normalBias = texelWorld * 1.5;
      // depth bias lives in normalized shadow-depth units → divide by range
      light.shadow.bias = -(texelWorld * 1.5) / depthRange;
      // PCSS penumbra scale: world softness cone → texels per depth unit
      const sunTan = Math.tan(0.00466 * this.sunSoftness);
      light.shadow.radius = (depthRange * sunTan) / texelWorld;
    }
  }
}
