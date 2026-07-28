import * as THREE from 'three/webgpu';

/**
 * Static irradiance cache (Lumen-style amortization).
 * Static world pays UPDATE only when dirty (sun moved / geo edit).
 * Every frame only SAMPLES the cached ambient bounce into a HemisphereLight.
 * Dynamic near-field bounce is handled by screen traces (SSGI/GTAO path).
 */
export class StaticIrradianceCache {
  readonly light: THREE.HemisphereLight;
  private lastSun = new THREE.Vector3(0, 1, 0);
  private dirty = true;
  /** degrees of sun movement before a rebuild */
  sunDirtyDeg = 4;

  /** warm ground / cool sky bounce — filled on update from sun + albedo hints */
  private sky = new THREE.Color(0.45, 0.55, 0.75);
  private ground = new THREE.Color(0.35, 0.28, 0.18);

  constructor() {
    this.light = new THREE.HemisphereLight(this.sky, this.ground, 0.0);
    this.light.userData.staticGi = true;
    this.light.name = 'StaticIrradianceCache';
  }

  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Call once per frame. Rebuild is free unless dirty; never full-scene RT.
   * Budget: constant-time SH-ish tint from sun color + scene albedo hints.
   */
  update(
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    opts?: { groundAlbedo?: THREE.Color; skyAlbedo?: THREE.Color; intensity?: number },
  ): void {
    const ang = THREE.MathUtils.radToDeg(this.lastSun.angleTo(sunDir));
    if (ang > this.sunDirtyDeg) this.dirty = true;

    if (!this.dirty) return;

    // Static update (amortized): one-shot color solve, not per-pixel
    const groundAlb = opts?.groundAlbedo ?? new THREE.Color(0.42, 0.32, 0.18);
    const skyAlb = opts?.skyAlbedo ?? new THREE.Color(0.35, 0.5, 0.85);
    const elev = Math.max(0.05, sunDir.y);

    // multi-bounce-ish: sky tinted by sun, ground receives sun * albedo
    this.sky.copy(skyAlb).multiply(sunColor).multiplyScalar(0.55 + elev * 0.35);
    this.ground.copy(groundAlb).multiply(sunColor).multiplyScalar(0.35 + elev * 0.55);
    // fill gaps with opposite bounce
    this.sky.lerp(this.ground, 0.12);
    this.ground.lerp(sunColor, 0.08);

    const inten = opts?.intensity ?? 0.85;
    this.light.color.copy(this.sky);
    this.light.groundColor.copy(this.ground);
    this.light.intensity = inten;

    this.lastSun.copy(sunDir);
    this.dirty = false;
  }

  /** Force rebuild next frame (scene edit / load). */
  invalidate(): void {
    this.dirty = true;
  }
}
