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
