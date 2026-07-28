import type { DirectionalLight, Vector3 } from 'three/webgpu';
import type { WorldState } from '../../shared/world/index.ts';

export interface TimeOfDayParams {
  azimuthDeg: number;
  elevationDeg: number;
  animate: boolean;
  /** Degrees of azimuth per second while animating. */
  speedDegPerSec: number;
  intensity: number;
}

/**
 * Drives the one sun.
 *
 * Note the split of responsibilities: this feature owns the *continuous* angle,
 * `WorldState` owns the *quantized* one. Caches key off the quantized value, so a
 * slow time-of-day sweep produces a discrete, budgetable stream of invalidations
 * rather than a fresh one every frame.
 *
 * Locked decision 3 in docs/ue-pipeline-study-and-plan.md: full runtime TOD must be
 * possible, so no cache downstream may assume the sun is fixed.
 */
export class TimeOfDay {
  readonly params: TimeOfDayParams;

  constructor(
    private readonly world: WorldState,
    private readonly light: DirectionalLight,
    /** How far from origin the directional light is parked. */
    private readonly distance = 120,
    params: Partial<TimeOfDayParams> = {},
  ) {
    this.params = {
      azimuthDeg: world.sun.azimuthDeg,
      elevationDeg: world.sun.elevationDeg,
      animate: false,
      speedDegPerSec: 3,
      intensity: world.sun.intensity,
      ...params,
    };
    this.sync();
  }

  update(dt: number): void {
    if (this.params.animate) {
      this.params.azimuthDeg =
        (this.params.azimuthDeg + this.params.speedDegPerSec * dt) % 360;
    }
    this.sync();
  }

  /** Pushes the continuous angle into WorldState and mirrors the result onto the light. */
  private sync(): void {
    this.world.setSunAngles(this.params.azimuthDeg, this.params.elevationDeg);
    this.world.sun.intensity = this.params.intensity;

    const dir: Vector3 = this.world.sun.direction;
    this.light.position.copy(dir).multiplyScalar(this.distance);
    this.light.target.position.set(0, 0, 0);
    this.light.target.updateMatrixWorld();

    // Horizon dimming — a placeholder for the atmosphere LUT that lands in Phase 4.
    // Kept crude and obvious rather than subtly wrong: the real sun colour must come
    // from transmittance, not from a curve invented here.
    const elevation = Math.max(0, Math.sin((this.params.elevationDeg * Math.PI) / 180));
    this.light.intensity = this.params.intensity * elevation;
    this.light.color.copy(this.world.sun.color);
  }
}
