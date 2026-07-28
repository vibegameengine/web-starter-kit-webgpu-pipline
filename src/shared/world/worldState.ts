import { Color, Vector3 } from 'three/webgpu';

/**
 * The sun is quantized before it is allowed to dirty anything.
 *
 * Reason: with a continuously moving sun, an un-quantized angle changes every
 * single frame, which would invalidate the static shadow cache and the GI cache
 * every single frame — i.e. the caches would cost more than they save. UE hits the
 * identical problem ("any light movement or rotation will invalidate all cached
 * pages for that light") and the answer is the same: move the sun in steps.
 */
export const SUN_QUANTIZATION_DEG = 0.25;

/** Angular radius of the real sun, in radians (~0.53° diameter). Drives penumbra width. */
export const SUN_ANGULAR_RADIUS = (0.53 * 0.5 * Math.PI) / 180;

export interface SunState {
  /** Unit vector pointing from the scene *towards* the sun (UE's light vector). */
  readonly direction: Vector3;
  readonly color: Color;
  intensity: number;
  /** Half-angle of the light source. Larger = softer penumbra. */
  angularRadius: number;
  /** Quantized. Read-only from outside; change via `setSunAngles`. */
  readonly azimuthDeg: number;
  readonly elevationDeg: number;
}

function quantize(deg: number): number {
  return Math.round(deg / SUN_QUANTIZATION_DEG) * SUN_QUANTIZATION_DEG;
}

/**
 * The single source of truth every pass reads from.
 *
 * Design law #3 from the UE study: one light state feeds shadows, base pass, GI
 * cache, fog froxels and the sky LUT. Nothing is allowed to invent its own sun.
 *
 * The two version counters are the entire invalidation system. Every cache stores
 * the versions it was built at and compares. The property that makes this work —
 * and the reason it is copied from UE rather than invented — is that **moving the
 * camera bumps nothing**.
 */
export class WorldState {
  /** Seconds since start. */
  time = 0;
  /** Seconds since previous frame, clamped. */
  dt = 0;
  frame = 0;

  readonly sun: SunState = {
    direction: new Vector3(),
    color: new Color(1, 0.96, 0.9),
    intensity: 5.0,
    angularRadius: SUN_ANGULAR_RADIUS,
    azimuthDeg: 0,
    elevationDeg: 0,
  };

  private _staticGeoVersion = 1;
  private _sunVersion = 1;

  constructor(azimuthDeg = 55, elevationDeg = 45) {
    this.setSunAngles(azimuthDeg, elevationDeg);
  }

  /** Bumped when static geometry is added, removed or edited. */
  get staticGeoVersion(): number {
    return this._staticGeoVersion;
  }

  /** Bumped when the sun crosses a quantization step. */
  get sunVersion(): number {
    return this._sunVersion;
  }

  markStaticGeoDirty(): void {
    this._staticGeoVersion++;
  }

  /**
   * Moves the sun. Returns true if the move actually crossed a quantization step
   * (and therefore invalidated the caches), false if it was swallowed.
   */
  setSunAngles(azimuthDeg: number, elevationDeg: number): boolean {
    const az = quantize(azimuthDeg);
    const el = quantize(Math.max(-90, Math.min(90, elevationDeg)));

    const sun = this.sun as {
      -readonly [K in keyof SunState]: SunState[K];
    };

    if (this._sunVersion > 1 && az === sun.azimuthDeg && el === sun.elevationDeg) {
      return false;
    }

    sun.azimuthDeg = az;
    sun.elevationDeg = el;

    const phi = (az * Math.PI) / 180;
    const theta = (el * Math.PI) / 180;
    const cosTheta = Math.cos(theta);
    sun.direction.set(
      cosTheta * Math.sin(phi),
      Math.sin(theta),
      cosTheta * Math.cos(phi),
    );

    this._sunVersion++;
    return true;
  }

  beginFrame(dt: number): void {
    this.dt = Math.min(dt, 0.1);
    this.time += this.dt;
    this.frame++;
  }
}

/**
 * Per-frame counters the HUD reads. The one that matters is `staticShadowRebuilds`:
 * Epic's stated health metric for Virtual Shadow Maps is that invalidated static
 * pages sit at ~0, and this is our version of that number. If it is non-zero while
 * the camera is merely flying around, the cache is broken.
 */
export class CacheStats {
  staticShadowRebuilds = 0;
  giBricksRefreshed = 0;
  private _window = 0;
  private _rebuildAccum = 0;
  private _brickAccum = 0;
  staticShadowRebuildsPerSec = 0;
  giBricksPerSec = 0;

  endFrame(dt: number): void {
    this._rebuildAccum += this.staticShadowRebuilds;
    this._brickAccum += this.giBricksRefreshed;
    this.staticShadowRebuilds = 0;
    this.giBricksRefreshed = 0;

    this._window += dt;
    if (this._window >= 0.5) {
      this.staticShadowRebuildsPerSec = this._rebuildAccum / this._window;
      this.giBricksPerSec = this._brickAccum / this._window;
      this._window = 0;
      this._rebuildAccum = 0;
      this._brickAccum = 0;
    }
  }
}
