/**
 * The ball's physics, alone on its own thread: Archimedes on a sphere over a free
 * surface the host samples for it. See docs/water/floating-ball.md.
 *
 * The host owns the water and the mesh; this thread owns nothing but the state
 * below, so a slow frame on the main thread never distorts the integration.
 */
export interface BallInit {
  radius: number;
  /** kg/m³. Water is 1000, so 250 rides with a quarter of the ball under. */
  density: number;
  half: number;
  waterLevel: number;
  start: { x: number; z: number };
}

/** One step of water as the host measured it, at the ball's own position. */
export interface BallStep {
  dt: number;
  /** Free surface over the still-water line, and its two slopes. */
  eta: number;
  slopeX: number;
  slopeZ: number;
  /** Depth-averaged current of the solver there, m/s. */
  flowX: number;
  flowZ: number;
  /** Bed height under the ball, absolute metres. */
  bed: number;
}

export type BallRequest =
  | { type: 'init'; init: BallInit }
  | { type: 'step'; step: BallStep };

export interface BallPose {
  x: number;
  y: number;
  z: number;
  /** Rolled angle and the heading its axis lies across, radians. */
  spin: number;
  yaw: number;
  /** How much of the ball is under water, 0..1 — the host shades the wet part. */
  wetted: number;
}

export type BallResponse = { type: 'pose'; pose: BallPose };

const GRAVITY = 9.81;
const RHO_WATER = 1000;
/** Drag against the water, per second, at full immersion; air is a fiftieth of it. */
const WATER_DRAG = 3.2;
/** How hard the current carries a fully wetted ball, per second. */
const FLOW_COUPLING = 2.6;
/** The ball keeps this share of its speed when it hits the bed. */
const BED_RESTITUTION = 0.45;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

class FloatingBall {
  private readonly position: { x: number; y: number; z: number };
  private readonly velocity = { x: 0, y: 0, z: 0 };
  private readonly mass: number;
  private spin = 0;
  private yaw = 0;
  private wetted = 0;

  constructor(private readonly init: BallInit) {
    this.mass = init.density * (4 / 3) * Math.PI * init.radius ** 3;
    this.position = { x: init.start.x, y: init.waterLevel + init.radius * 0.6, z: init.start.z };
  }

  /** Buoyant acceleration from the submerged cap: ρ_w·g·V(s) over the ball's mass. */
  private lift(surfaceY: number): number {
    const r = this.init.radius;
    const s = clamp(surfaceY - (this.position.y - r), 0, 2 * r);
    this.wetted = clamp(s / r, 0, 1);
    const volume = (Math.PI / 3) * s * s * (3 * r - s);
    return (RHO_WATER * GRAVITY * volume) / this.mass;
  }

  private accelerate(step: BallStep, lift: number): void {
    const { velocity, wetted } = this;
    const drag = WATER_DRAG * wetted + 0.06;
    const flow = FLOW_COUPLING * wetted;
    // The buoyant force stands normal to the free surface, so its horizontal share is
    // the surface slope: the swell carries the ball instead of passing under it.
    velocity.x += (-step.slopeX * lift + (step.flowX - velocity.x) * flow) * step.dt;
    velocity.z += (-step.slopeZ * lift + (step.flowZ - velocity.z) * flow) * step.dt;
    velocity.y += (lift - GRAVITY - velocity.y * drag) * step.dt;
  }

  private resolveBed(bed: number): void {
    const rest = bed + this.init.radius;
    if (this.position.y >= rest) return;
    this.position.y = rest;
    if (this.velocity.y < 0) this.velocity.y = -this.velocity.y * BED_RESTITUTION;
    this.velocity.x *= 0.86;
    this.velocity.z *= 0.86;
  }

  private resolveRim(): void {
    const limit = this.init.half - 0.35;
    for (const axis of ['x', 'z'] as const) {
      if (Math.abs(this.position[axis]) <= limit) continue;
      this.position[axis] = Math.sign(this.position[axis]) * limit;
      this.velocity[axis] = -this.velocity[axis] * 0.4;
    }
  }

  /** Rolling contact: the spin follows ω = |v| / r, the axis lies across the motion. */
  private rollTo(dt: number): void {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (speed > 1e-3) {
      const target = Math.atan2(this.velocity.z, this.velocity.x);
      const delta = Math.atan2(Math.sin(target - this.yaw), Math.cos(target - this.yaw));
      this.yaw += delta * Math.min(1, dt * 4);
    }
    this.spin = (this.spin + (speed * dt) / this.init.radius) % (Math.PI * 2);
  }

  step(step: BallStep): BallPose {
    const dt = clamp(step.dt, 0.0005, 0.05);
    const lift = this.lift(this.init.waterLevel + step.eta);
    this.accelerate({ ...step, dt }, lift);
    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;
    this.resolveBed(step.bed);
    this.resolveRim();
    this.rollTo(dt);
    return { ...this.position, spin: this.spin, yaw: this.yaw, wetted: this.wetted };
  }
}

let ball: FloatingBall | null = null;

self.onmessage = (event: MessageEvent<BallRequest>) => {
  const message = event.data;
  if (message.type === 'init') {
    ball = new FloatingBall(message.init);
    return;
  }
  if (!ball) throw new Error('ball worker stepped before init');
  const response: BallResponse = { type: 'pose', pose: ball.step(message.step) };
  self.postMessage(response);
};
