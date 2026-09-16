import { acos, clamp, cos, float, max, select, sin, sqrt, texture, vec2, vec3 } from 'three/tsl';
import type * as THREE from 'three/webgpu';
import type { AtmosphereUniforms } from './atmosphereParameters.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export function texelCentreUv(unit: N, size: [number, number]): N {
  const texels = vec2(size[0], size[1]);
  return unit.mul(texels.sub(1)).add(0.5).div(texels);
}

export function transmittanceLutParameters(atmosphere: AtmosphereUniforms, unit: N): { radius: N; cosZenith: N } {
  const ground = atmosphere.groundRadius;
  const top = atmosphere.topRadius;
  const horizon = sqrt(top.mul(top).sub(ground.mul(ground)));
  const rho = horizon.mul(unit.y);
  const radius = sqrt(rho.mul(rho).add(ground.mul(ground)));
  const shortest = top.sub(radius);
  const longest = rho.add(horizon);
  const distance = shortest.add(unit.x.mul(longest.sub(shortest)));
  const cosZenith = select(
    distance.lessThan(1e-4),
    float(1),
    horizon.mul(horizon).sub(rho.mul(rho)).sub(distance.mul(distance)).div(radius.mul(distance).mul(2)),
  );
  return { radius, cosZenith: clamp(cosZenith, -1, 1) };
}

export function transmittanceLutUnit(atmosphere: AtmosphereUniforms, radius: N, cosZenith: N): N {
  const ground = atmosphere.groundRadius;
  const top = atmosphere.topRadius;
  const horizon = sqrt(max(top.mul(top).sub(ground.mul(ground)), 0));
  const rho = sqrt(max(radius.mul(radius).sub(ground.mul(ground)), 0));
  const discriminant = radius.mul(radius).mul(cosZenith.mul(cosZenith).sub(1)).add(top.mul(top));
  const distance = max(radius.negate().mul(cosZenith).add(sqrt(max(discriminant, 0))), 0);
  const shortest = top.sub(radius);
  const longest = rho.add(horizon);
  return vec2(distance.sub(shortest).div(max(longest.sub(shortest), 1e-4)), rho.div(horizon));
}

export interface LutSource {
  texture: THREE.Texture;
  size: [number, number];
  atmosphere: AtmosphereUniforms;
}

export function readTransmittance(lut: LutSource, radius: N, cosZenith: N): N {
  const uv = texelCentreUv(transmittanceLutUnit(lut.atmosphere, radius, cosZenith), lut.size);
  return texture(lut.texture, uv).level(float(0)).rgb;
}

export function horizonAngles(atmosphere: AtmosphereUniforms, radius: N): { zenithToHorizon: N; belowHorizon: N } {
  const ground = atmosphere.groundRadius;
  const cosBeta = sqrt(max(radius.mul(radius).sub(ground.mul(ground)), 0)).div(radius);
  const beta = acos(cosBeta.clamp(-1, 1));
  return { zenithToHorizon: float(Math.PI).sub(beta), belowHorizon: beta };
}

/* @important The sky-view texture spends its rows on the horizon and its columns on the sun.
   Rows follow the horizon-concentrated split of Hillaire 2020 (section 5.3): a square law on each
   side of the horizon, so a 1 km haze band gets as many texels as the whole zenith. Columns are
   ours: the sky is mirror-symmetric about the plane through the zenith and the sun, so only
   0..pi of relative azimuth is stored, and a square-root law packs texels next to the sun where
   the aerosol glow changes over a fraction of a degree. */
export function skyViewDirection(atmosphere: AtmosphereUniforms, radius: N, unit: N): N {
  const { zenithToHorizon, belowHorizon } = horizonAngles(atmosphere, radius);
  const aboveCoord = float(1).sub(float(1).sub(unit.y.mul(2)).pow(2));
  const belowCoord = unit.y.mul(2).sub(1).pow(2);
  const zenith = select(unit.y.lessThan(0.5), zenithToHorizon.mul(aboveCoord), zenithToHorizon.add(belowHorizon.mul(belowCoord)));
  const azimuth = unit.x.mul(unit.x).mul(Math.PI);
  return vec3(sin(zenith).mul(cos(azimuth)), cos(zenith), sin(zenith).mul(sin(azimuth)));
}

export function skyViewUnit(atmosphere: AtmosphereUniforms, radius: N, cosZenith: N, relativeAzimuth: N): N {
  const { zenithToHorizon, belowHorizon } = horizonAngles(atmosphere, radius);
  const zenith = acos(clamp(cosZenith, -1, 1));
  const above = float(1).sub(sqrt(max(float(1).sub(zenith.div(zenithToHorizon)), 0))).mul(0.5);
  const below = sqrt(max(zenith.sub(zenithToHorizon).div(belowHorizon), 0)).mul(0.5).add(0.5);
  const v = select(zenith.lessThan(zenithToHorizon), above, below);
  return vec2(sqrt(clamp(relativeAzimuth.div(Math.PI), 0, 1)), v);
}
