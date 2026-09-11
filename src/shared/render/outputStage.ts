import * as THREE from 'three/webgpu';
import { float, hash, luminance, renderOutput, screenCoordinate, vec4 } from 'three/tsl';
import type { ArtisticLook } from './look.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const GRAIN_PIXEL_STRIDE = 7919;
const GRAIN_FRAME_STRIDE = 104729;
const GRAIN_HIGHLIGHT_FALLOFF = 0.6;

export interface OutputStages {
  exposure: N | null;
  look: ArtisticLook | null;
  grain: THREE.UniformNode<number> | null;
  frameIndex: N;
}

function filmGrain(exposed: N, strength: THREE.UniformNode<number>, frameIndex: N): N {
  const display = renderOutput(exposed);
  const pixel = screenCoordinate.x.floor().add(screenCoordinate.y.floor().mul(GRAIN_PIXEL_STRIDE)).add(frameIndex.mul(GRAIN_FRAME_STRIDE));
  const noise = hash(pixel).sub(0.5);
  const shadowWeight = float(1).sub(luminance(display.rgb).clamp(0, 1).mul(GRAIN_HIGHLIGHT_FALLOFF));
  return vec4(display.rgb.add(noise.mul(strength).mul(shadowWeight)), display.a);
}

/* @important Exposure and the look scale rgb only. A vec4 multiply took the alpha with it,
   the canvas composites over the page, and half the background bled into every pixel: the
   acceptance x2 exposure step measured 1.93 instead of 2 until alpha was left alone.
   @important Exposure runs after AA so the meter and the TAA history stay scene-referred,
   the look's compensation rides on the metered value without being measured back, and the
   grade is the last thing in scene-linear HDR before the single output transform. Grain is
   display-referred, which is why it takes the output transform away from three. */
export function applyOutputStages(frame: N, stages: OutputStages): { node: N; outputColorTransform: boolean } {
  let exposed: N = vec4(frame);
  if (stages.exposure) exposed = vec4(exposed.rgb.mul(stages.exposure), exposed.a);
  if (stages.look) exposed = vec4(stages.look.grade(vec4(exposed.rgb.mul(stages.look.exposureGain), exposed.a)));
  if (!stages.grain) return { node: exposed, outputColorTransform: true };
  return { node: filmGrain(exposed, stages.grain, stages.frameIndex), outputColorTransform: false };
}
