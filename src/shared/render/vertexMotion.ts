import * as THREE from 'three/webgpu';
import { metalness, modelWorldMatrix, mrt, positionLocal, roughness, uniform, vec4 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Unjittered view-projection of the current frame and of the previous one (see TemporalAANode.trackCamera). */
export const U_VIEW_PROJECTION = uniform(new THREE.Matrix4());
export const U_PREVIOUS_VIEW_PROJECTION = uniform(new THREE.Matrix4());

/**
 * Motion vectors for vertex-animated geometry.
 *
 * three's `velocity` node reprojects `positionPrevious`, which is the *undisplaced*
 * geometry position: for a material that moves its vertices in the shader (wind on a
 * frond) the "previous" position is wrong by the whole displacement, so every leaf
 * reports a velocity of tens of pixels while standing still, the TAA reprojects its
 * history from the wrong place, clips it, and the leaves wobble with the jitter
 * (bisected 2026-09-08: velocity mean 2.4 px on a still scene, TAA residual
 * independent of the history weight).
 *
 * This evaluates the same displacement at the previous frame's time and projects both
 * with the unjittered view-projections the TAA tracks. The object's own matrix is
 * taken as static, which holds for the foliage here (only vertices move).
 */
export function vertexMotionVelocity(displaceAt: (time: N) => N, timeNow: N, timePrev: N): N {
  const worldNow = modelWorldMatrix.mul(vec4(positionLocal.add(displaceAt(timeNow)), 1));
  const worldPrev = modelWorldMatrix.mul(vec4(positionLocal.add(displaceAt(timePrev)), 1));
  const clipNow = U_VIEW_PROJECTION.mul(worldNow);
  const clipPrev = U_PREVIOUS_VIEW_PROJECTION.mul(worldPrev);
  return clipNow.xy.div(clipNow.w).sub(clipPrev.xy.div(clipPrev.w));
}

/**
 * @important Motion vectors for a mesh whose vertices do not move.
 *
 * three r182's `velocity` node reprojects `positionPrevious`, which is
 * `positionGeometry`: for an InstancedMesh the *current* clip position comes from
 * `positionLocal`, which InstanceNode has already multiplied by `instanceMatrix`,
 * while the previous one has not — so a motionless instance reports its whole
 * placement as velocity (measured 2026-09-11 on the village with
 * `scripts/_village_velocity.mjs`: mean 50.4 px and 25 % of instanced pixels above
 * 0.05 px, against exactly 0 for the plain meshes of the same frame), TAA fetches
 * history from the wrong place, and the village shimmers while the beach does not.
 *
 * Both projections here use `positionLocal`, so the instance transform is in both and
 * the only motion left is the camera's. Static meshes only: the object's own matrix is
 * taken as unchanged between the two frames.
 */
export function installStaticMotion(material: THREE.NodeMaterial): void {
  const world = modelWorldMatrix.mul(vec4(positionLocal, 1));
  const clipNow = U_VIEW_PROJECTION.mul(world);
  const clipPrev = U_PREVIOUS_VIEW_PROJECTION.mul(world);
  material.mrtNode = mrt({
    velocity: vec4(clipNow.xy.div(clipNow.w).sub(clipPrev.xy.div(clipPrev.w)), metalness, roughness),
  });
  material.userData.staticMotionNode = material.mrtNode;
}

/**
 * Sets the material's vertex displacement and the matching motion vector in one
 * place, so the two can never disagree. `timeNow`/`timePrev` are the entity's wind
 * clock uniforms; the entity advances `timePrev` before `timeNow` each frame.
 */
export function installVertexMotion(material: THREE.NodeMaterial, displaceAt: (time: N) => N, timeNow: N, timePrev: N): void {
  material.positionNode = positionLocal.add(displaceAt(timeNow));
  material.mrtNode = mrt({
    velocity: vec4(vertexMotionVelocity(displaceAt, timeNow, timePrev), metalness, roughness),
  });
}
