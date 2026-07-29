// @ts-nocheck -- storage-node naming and wgslFn dependency conventions follow the
// vendored webgiya modules this is bound into.
import * as THREE from 'three/webgpu';
import { texture, uniform } from 'three/tsl';
import { giKnobs } from './knobs';

/**
 * Every analytic light in the scene, as one small float texture the ray tracers read.
 *
 * The integrator used to take a `THREE.DirectionalLight` and shade every ray hit with
 * it, which made "the sun" and "light" the same word all the way down: a campfire threw
 * no bounce, a torch lit nothing but the polygon it was drawn on, and the only way to
 * get warm indirect light into a forest clearing was to move the sun. Lumen does not
 * work that way — arbitrary light types are injected into the surface cache, which is
 * what makes a lantern in a cave read as a lantern in a cave.
 *
 * A texture rather than a storage buffer, and that is not a stylistic choice. The
 * surfel integrator already binds fourteen storage buffers in one compute stage — four
 * for the static BVH, four for the dynamic one, six for the pool — and fourteen is the
 * WebGPU *default* per-stage limit that `render/renderer.ts` already requests by name.
 * A fifteenth fails pipeline creation outright, and raising the requested limit is not
 * portable: this adapter allows sixteen, plenty of hardware allows exactly fourteen,
 * and a `requiredLimits` the device refuses does not degrade, it throws during boot.
 * Sixty-four floats of light data do not need a storage binding to travel; a 4×16 RGBA
 * float texture read with `textureLoad` costs one sampled-texture slot, of which the
 * integrator uses three out of sixteen.
 *
 * It is allocated once at module scope, at a fixed `MAX_GI_LIGHTS`, and never resized —
 * every pass that traces (the surfel integrator, the screen probes, reflections) reads
 * this one object, and a texture that could be replaced would invalidate all of their
 * pipelines at once. Sixteen is a refusal rather than a target: past it we say so out
 * loud and drop the dimmest, because a light that silently stops contributing to GI is
 * indistinguishable from a light that is simply far away.
 */
export const MAX_GI_LIGHTS = 16;

/** Texels per light — one row of the texture. Mirrored in WGSL as `GI_LIGHT_STRIDE`. */
const VEC4_PER_LIGHT = 4;

export const GI_LIGHT_DIRECTIONAL = 0;
export const GI_LIGHT_POINT = 1;
export const GI_LIGHT_SPOT = 2;

const lightArray = new Float32Array(MAX_GI_LIGHTS * VEC4_PER_LIGHT * 4);

const lightTexture = new THREE.DataTexture(
  lightArray,
  VEC4_PER_LIGHT,
  MAX_GI_LIGHTS,
  THREE.RGBAFormat,
  THREE.FloatType,
);
lightTexture.name = 'GiLights';
lightTexture.colorSpace = THREE.NoColorSpace;
// Nearest and no mips: this is a data table, and a filtered read of a light table
// returns a light that is not in the scene. It is also what keeps the texture legal
// without the `float32-filterable` device feature.
lightTexture.minFilter = THREE.NearestFilter;
lightTexture.magFilter = THREE.NearestFilter;
lightTexture.generateMipmaps = false;
lightTexture.flipY = false;
lightTexture.needsUpdate = true;

/**
 * The node a consumer passes into its kernel as the `lightsTex` argument. Not a
 * dependency-list entry — a plain `texture_2d<f32>` parameter, the same way
 * `blueNoiseTex` travels.
 */
export const giLightsTexture = texture(lightTexture);

/** How many entries of the buffer are live this frame. */
export const U_GI_LIGHT_COUNT = uniform(0);

/**
 * Lights sampled per ray, when the list is longer than this.
 *
 * A shadow ray per light per sample is the naive reading of "shadow rays cast per
 * light", and it makes ray cost linear in a number that has nothing to do with how much
 * any one light contributes: sixteen lights would be sixteen times the trace budget for
 * a frame that mostly looks the same. Instead a ray picks this many lights by
 * stratified selection and scales the result by `count / samples`, so the estimator
 * stays unbiased and the cost stays flat. Below the threshold every light is evaluated
 * exactly, because two extra shadow rays are cheaper than the variance of guessing.
 */
export const U_GI_LIGHT_SAMPLES = uniform(Math.max(1, giKnobs.lightSamples()));

/** Global multiplier for the emissive channel; see `diffuseArray.ts`. */
export const U_GI_EMISSIVE_SCALE = uniform(1);

/**
 * First layer of the diffuse array holding emissive, or -1 when the scene has none.
 * A uniform rather than a constant because the array is built once per scene and the
 * integrator's pipeline outlives any particular scene's answer.
 */
export const U_GI_EMISSIVE_BASE = uniform(-1);

const _pos = new THREE.Vector3();
const _target = new THREE.Vector3();
const _dir = new THREE.Vector3();

type AnyLight = THREE.Light & {
  isDirectionalLight?: boolean;
  isPointLight?: boolean;
  isSpotLight?: boolean;
  distance?: number;
  angle?: number;
  penumbra?: number;
  decay?: number;
  target?: THREE.Object3D;
};

let overflowReported = false;

/**
 * Refreshes the buffer from the scene graph. Cheap enough to call every frame — it is
 * a walk over `Object3D.isLight` and sixteen float writes — and it has to be, because
 * the sun's angles are on a GUI slider and a light the tracer knows at a stale position
 * is worse than one it does not know at all.
 *
 * Returns the number of lights uploaded.
 */
export function syncSceneLights(scene: THREE.Object3D): number {
  const found: AnyLight[] = [];

  // The ablation drops punctual lights from the *tracer* only. They stay in the scene,
  // stay in the raster, and still light the surface they stand on directly — so a pair
  // of captures taken across `?lights=0` differs in exactly one thing: whether their
  // light is allowed to bounce.
  const punctual = giKnobs.analyticLights();

  scene.traverse((object) => {
    const light = object as AnyLight;
    if (!(light as THREE.Light).isLight || !light.visible) return;
    if (light.isDirectionalLight) {
      found.push(light);
    } else if (punctual && (light.isPointLight || light.isSpotLight)) {
      found.push(light);
    }
  });

  // Brightest first, so the refusal below throws away the least visible thing rather
  // than whichever light happened to be added last.
  found.sort(
    (a, b) => (b.intensity ?? 0) - (a.intensity ?? 0),
  );

  if (found.length > MAX_GI_LIGHTS && !overflowReported) {
    overflowReported = true;
    console.error(
      `[gi] ${found.length} analytic lights in the scene and the GI light buffer holds ` +
        `${MAX_GI_LIGHTS}. The ${found.length - MAX_GI_LIGHTS} dimmest are now INVISIBLE ` +
        'to every ray: they still raster, so the surface they stand on is lit and the ' +
        'bounce off it is not. Raise MAX_GI_LIGHTS in sceneLights.ts, or cull lights ' +
        'before they reach the tracer.',
    );
  }

  const count = Math.min(found.length, MAX_GI_LIGHTS);

  for (let i = 0; i < count; i++) {
    const light = found[i];
    const base = i * VEC4_PER_LIGHT * 4;

    light.updateWorldMatrix(true, false);
    _pos.setFromMatrixPosition(light.matrixWorld);

    const intensity = light.intensity ?? 1;
    const colour = light.color ?? new THREE.Color(1, 1, 1);

    let type = GI_LIGHT_POINT;
    let cosOuter = -1;
    let cosInner = -1;
    let range = 0;
    let decay = 2;

    if (light.isDirectionalLight) {
      type = GI_LIGHT_DIRECTIONAL;
      const target = light.target ?? null;
      if (target) {
        target.updateWorldMatrix(true, false);
        _target.setFromMatrixPosition(target.matrixWorld);
      } else {
        _target.set(0, 0, 0);
      }
      // Stored pointing *at* the light, which is the `L` every BRDF below wants and
      // saves a negate on the hottest line in the tracer.
      _dir.subVectors(_pos, _target).normalize();
    } else if (light.isSpotLight) {
      type = GI_LIGHT_SPOT;
      const target = light.target ?? null;
      if (target) {
        target.updateWorldMatrix(true, false);
        _target.setFromMatrixPosition(target.matrixWorld);
      } else {
        _target.set(0, 0, 0);
      }
      // Spot axis points away from the light, so the cone test is a dot against the
      // *negated* direction to the shading point. Kept in this orientation because it
      // is how three.js authors a spot and how anyone reading the scene expects it.
      _dir.subVectors(_target, _pos).normalize();
      const angle = light.angle ?? Math.PI / 3;
      const penumbra = THREE.MathUtils.clamp(light.penumbra ?? 0, 0, 1);
      cosOuter = Math.cos(angle);
      cosInner = Math.cos(angle * (1 - penumbra));
      range = light.distance ?? 0;
      decay = light.decay ?? 2;
    } else {
      _dir.set(0, -1, 0);
      range = light.distance ?? 0;
      decay = light.decay ?? 2;
    }

    lightArray[base + 0] = _pos.x;
    lightArray[base + 1] = _pos.y;
    lightArray[base + 2] = _pos.z;
    lightArray[base + 3] = type;

    lightArray[base + 4] = colour.r * intensity;
    lightArray[base + 5] = colour.g * intensity;
    lightArray[base + 6] = colour.b * intensity;
    lightArray[base + 7] = range;

    lightArray[base + 8] = _dir.x;
    lightArray[base + 9] = _dir.y;
    lightArray[base + 10] = _dir.z;
    lightArray[base + 11] = cosOuter;

    lightArray[base + 12] = cosInner;
    lightArray[base + 13] = decay;
    lightArray[base + 14] = 0;
    lightArray[base + 15] = 0;
  }

  // Zeroing the tail matters: a stale entry past `count` is never read by the shader,
  // but a readback or a future off-by-one would find a light that is not in the scene.
  lightArray.fill(0, count * VEC4_PER_LIGHT * 4);

  lightTexture.needsUpdate = true;
  U_GI_LIGHT_COUNT.value = count;
  return count;
}

/** What is currently in the buffer, for the HUD and for measurement harnesses. */
export function giLightSummary(): Array<{
  type: number;
  position: [number, number, number];
  colour: [number, number, number];
  range: number;
}> {
  const out = [];
  for (let i = 0; i < U_GI_LIGHT_COUNT.value; i++) {
    const b = i * VEC4_PER_LIGHT * 4;
    out.push({
      type: lightArray[b + 3],
      position: [lightArray[b], lightArray[b + 1], lightArray[b + 2]] as [
        number,
        number,
        number,
      ],
      colour: [lightArray[b + 4], lightArray[b + 5], lightArray[b + 6]] as [
        number,
        number,
        number,
      ],
      range: lightArray[b + 7],
    });
  }
  return out;
}
