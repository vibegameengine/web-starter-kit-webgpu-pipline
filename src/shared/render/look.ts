import * as THREE from 'three/webgpu';
import { Fn, float, luminance, min, mix, pow, select, smoothstep, uniform, vec3, vec4 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export type OutputTransform = 'neutral' | 'agx' | 'linear';

export interface LookState {
  version: 1;
  exposureEV: number;
  indirectEV: number;
  indirectChroma: number;
  saturation: number;
  contrast: number;
  shadowLiftEV: number;
  creativeBalanceRGBStops: [number, number, number];
  output: OutputTransform;
}

export const NEUTRAL_LOOK: Readonly<LookState> = {
  version: 1,
  exposureEV: 0,
  indirectEV: 0,
  indirectChroma: 1,
  saturation: 1,
  contrast: 1,
  shadowLiftEV: 0,
  creativeBalanceRGBStops: [0, 0, 0],
  output: 'neutral',
};

const CURVE_PIVOT = 0.18;
const SHADOW_RANGE = [0.02, 0.18] as const;
const LUMINANCE_FLOOR = 1e-6;

export const TONE_MAPPING: Readonly<Record<OutputTransform, THREE.ToneMapping>> = {
  neutral: THREE.NeutralToneMapping,
  agx: THREE.AgXToneMapping,
  linear: THREE.NoToneMapping,
};

/* @important Two module-level uniforms rather than a parameter threaded through every
   reader: the lightmap, probe and live-surfel readers are installed in three different
   subsystems, and each already carries its own transport intensity. The art gain has to
   stay out of those, or a slider would be baked into the next atlas. */
export const U_LOOK_INDIRECT_GAIN = uniform(1);
export const U_LOOK_INDIRECT_CHROMA = uniform(1);

export function artisticIndirect(sampledIrradiance: N): N {
  const light = vec3(sampledIrradiance);
  return mix(vec3(luminance(light)), light, U_LOOK_INDIRECT_CHROMA).mul(U_LOOK_INDIRECT_GAIN);
}

function shapeLuminance(colour: N, contrast: N, shadowLiftEV: N): N {
  const y = luminance(colour).max(LUMINANCE_FLOOR);
  const shadowWeight = smoothstep(SHADOW_RANGE[0], SHADOW_RANGE[1], y).oneMinus();
  const curved = float(CURVE_PIVOT).mul(pow(y.div(CURVE_PIVOT), contrast));
  return colour.mul(curved.mul(shadowLiftEV.mul(shadowWeight).exp2()).div(y));
}

/* @important Saturation keeps luminance and never drives a channel negative: for a
   channel below grey the strength that would reach zero is Y/(-d), which is at least 1,
   so taking the smallest of those caps oversaturation instead of clamping the whole HDR
   frame to [0,1] and eating the highlights. */
function saturateAtConstantLuminance(colour: N, saturation: N): N {
  const y = luminance(colour);
  const offset = colour.sub(y);
  const headroom = (channel: N) => select(channel.lessThan(0), y.div(channel.negate().max(LUMINANCE_FLOOR)), float(1e6));
  const limit = min(min(headroom(offset.r), headroom(offset.g)), headroom(offset.b));
  return vec3(y).add(offset.mul(min(saturation, limit)));
}

export class ArtisticLook {
  readonly state: LookState;
  readonly exposureGain = uniform(1);
  readonly balance = uniform(new THREE.Vector3(1, 1, 1));
  readonly contrast = uniform(1);
  readonly shadowLiftEV = uniform(0);
  readonly saturation = uniform(1);

  constructor(state: Partial<LookState> = {}) {
    const stops = [...(state.creativeBalanceRGBStops ?? NEUTRAL_LOOK.creativeBalanceRGBStops)] as [number, number, number];
    this.state = { ...NEUTRAL_LOOK, ...state, creativeBalanceRGBStops: stops };
    this.sync();
  }

  get neutral(): boolean {
    const s = this.state;
    return s.exposureEV === 0 && s.indirectEV === 0 && s.indirectChroma === 1 && s.saturation === 1
      && s.contrast === 1 && s.shadowLiftEV === 0 && s.creativeBalanceRGBStops.every((stop) => stop === 0);
  }

  sync(active = true): void {
    const s = active ? this.state : NEUTRAL_LOOK;
    this.exposureGain.value = 2 ** s.exposureEV;
    this.balance.value.set(2 ** s.creativeBalanceRGBStops[0], 2 ** s.creativeBalanceRGBStops[1], 2 ** s.creativeBalanceRGBStops[2]);
    this.contrast.value = s.contrast;
    this.shadowLiftEV.value = s.shadowLiftEV;
    this.saturation.value = Math.max(0, s.saturation);
    U_LOOK_INDIRECT_GAIN.value = 2 ** s.indirectEV;
    U_LOOK_INDIRECT_CHROMA.value = Math.min(1, Math.max(0, s.indirectChroma));
  }

  grade(frame: N): N {
    const graded = Fn(([colour]: [N]) => {
      const balanced = colour.mul(this.balance);
      return saturateAtConstantLuminance(shapeLuminance(balanced, this.contrast, this.shadowLiftEV), this.saturation);
    });
    const rgba = vec4(frame);
    return vec4(graded(rgba.rgb), rgba.a);
  }
}
