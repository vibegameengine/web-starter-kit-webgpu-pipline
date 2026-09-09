import * as THREE from 'three/webgpu';
import { abs, atan2, floor, mix, normalize, positionLocal, smoothstep, step, vec3 } from 'three/tsl';
import type { BallPose, BallRequest, BallResponse } from './ballWorker.ts';

/**
 * A ball adrift on the lagoon. Its physics runs on its own thread (ballWorker.ts);
 * this side owns the mesh, samples the water under the ball and applies the pose.
 */
export interface BallWater {
  /** The free surface at a world point: height over the still line and its slopes. */
  sampleSurface(x: number, z: number): Promise<{ eta: number; slopeX: number; slopeZ: number }>;
  /** Bed height under a world point, absolute metres. */
  bedAt(x: number, z: number): number;
  waterLevel: number;
  half: number;
}

export interface BallOptions {
  water: BallWater;
  radius?: number;
  /** kg/m³. Water is 1000: a beach ball is mostly air, and rides with a tenth under. */
  density?: number;
  start?: THREE.Vector2;
}

export interface Ball {
  mesh: THREE.Mesh;
  /** Advances the ball by `dt` seconds of the water's own clock. */
  update(dt: number): void;
  /** The last pose the worker sent — for checks, not for the frame. */
  pose(): BallPose | null;
  /** The water the ball was last given — for checks. */
  reading(): { eta: number; slopeX: number; slopeZ: number; bed: number };
}

/** Classic panels: three meridian colours and two white caps, in the ball's own frame. */
function panelColour() {
  const dir = normalize(positionLocal);
  const sector = floor(atan2(dir.z, dir.x).mul(3 / Math.PI).add(6.0)).mod(3.0);
  const warm = mix(vec3(0.86, 0.16, 0.13), vec3(0.95, 0.76, 0.12), step(0.5, sector));
  return mix(mix(warm, vec3(0.11, 0.42, 0.78), step(1.5, sector)), vec3(0.95, 0.95, 0.93), smoothstep(0.72, 0.86, abs(dir.y)));
}

function createMesh(radius: number): THREE.Mesh {
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = 'beachBall';
  material.roughness = 0.42;
  material.metalness = 0;
  material.colorNode = panelColour();
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), material);
  mesh.name = 'beachBall';
  return mesh;
}

export function createFloatingBall(options: BallOptions): Ball {
  const { water, radius = 0.16, density = 80, start = new THREE.Vector2(-2.6, 1.2) } = options;
  const mesh = createMesh(radius);
  mesh.position.set(start.x, water.waterLevel + radius * 0.6, start.y);

  const worker = new Worker(new URL('./ballWorker.ts', import.meta.url), { type: 'module', name: 'floatingBall' });
  const send = (message: BallRequest) => worker.postMessage(message);
  send({ type: 'init', init: { radius, density, half: water.half, waterLevel: water.waterLevel, start: { x: start.x, z: start.y } } });

  let latest: BallPose | null = null;
  const axis = new THREE.Vector3();
  worker.onmessage = (event: MessageEvent<BallResponse>) => {
    const { pose } = event.data;
    latest = pose;
    mesh.position.set(pose.x, pose.y, pose.z);
    axis.set(Math.sin(pose.yaw), 0, -Math.cos(pose.yaw));
    mesh.quaternion.setFromAxisAngle(axis, pose.spin);
  };

  // The water lives on the GPU, so the surface under the ball is read back — one
  // 2x2 patch, one read in flight at a time. A late read costs the physics nothing:
  // it keeps integrating on the last surface it was given.
  let sampling = false;
  let surface = { eta: 0, slopeX: 0, slopeZ: 0 };
  const sample = (x: number, z: number) => {
    if (sampling) return;
    sampling = true;
    // Off the render loop: a readback issued while the frame's targets are bound
    // reads the wrong texture and leaves the renderer in a state it does not
    // recover from (the water inspector learned this first).
    setTimeout(() => {
      void water.sampleSurface(x, z)
        .then((next) => { surface = next; })
        .catch(() => undefined)
        .finally(() => { sampling = false; });
    }, 0);
  };

  let bed = 0;
  const update = (dt: number) => {
    const { x, z } = mesh.position;
    sample(x, z);
    bed = water.bedAt(x, z);
    send({ type: 'step', step: { dt, ...surface, flowX: 0, flowZ: 0, bed } });
  };

  return { mesh, update, pose: () => latest, reading: () => ({ ...surface, bed }) };
}
