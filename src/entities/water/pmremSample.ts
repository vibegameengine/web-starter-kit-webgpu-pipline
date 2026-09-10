import { wgslFn } from 'three/tsl';

const atlasUv = wgslFn(`
  fn waterPmremUv(d: vec3f, mip: f32, maxMip: f32, dimensions: vec2f) -> vec2f {
    let a = abs(d);
    var face: u32;
    var uv: vec2f;
    if (a.x > a.z && a.x > a.y) {
      if (d.x > 0.0) { face = 0u; uv = vec2f(d.z, d.y) / a.x; }
      else { face = 3u; uv = vec2f(-d.z, d.y) / a.x; }
    } else if (a.z >= a.x && a.z > a.y) {
      if (d.z > 0.0) { face = 2u; uv = vec2f(-d.x, d.y) / a.z; }
      else { face = 5u; uv = vec2f(d.x, d.y) / a.z; }
    } else {
      if (d.y > 0.0) { face = 1u; uv = vec2f(-d.x, -d.z) / a.y; }
      else { face = 4u; uv = vec2f(-d.x, d.z) / a.y; }
    }
    let tile = exp2(max(mip, 4.0));
    uv = (uv * 0.5 + 0.5) * (tile - 2.0) + 1.0;
    if (face > 2u) { uv.y += tile; face -= 3u; }
    uv.x += f32(face) * tile + max(4.0 - mip, 0.0) * 48.0;
    uv.y += 4.0 * (exp2(maxMip) - tile);
    return uv / dimensions;
  }
`);

export const sampleWaterPmrem = wgslFn(`
  fn sampleWaterPmrem(atlas: texture_2d<f32>, atlasSampler: sampler, direction: vec3f, roughness: f32) -> vec3f {
    let dimensions = vec2f(textureDimensions(atlas));
    let maxMip = log2(dimensions.y) - 2.0;
    var mip: f32;
    if (roughness >= 0.8) { mip = (1.0 - roughness) / 0.2 - 2.0; }
    else if (roughness >= 0.4) { mip = (0.8 - roughness) * 7.5 - 1.0; }
    else if (roughness >= 0.305) { mip = (0.4 - roughness) / 0.095 + 2.0; }
    else if (roughness >= 0.21) { mip = (0.305 - roughness) / 0.095 + 3.0; }
    else { mip = -2.0 * log2(1.16 * max(roughness, 0.00001)); }
    mip = clamp(mip, -2.0, maxMip);
    let lo = floor(mip);
    let first = textureSampleLevel(atlas, atlasSampler, waterPmremUv(direction, lo, maxMip, dimensions), 0.0).rgb;
    let second = textureSampleLevel(atlas, atlasSampler, waterPmremUv(direction, lo + 1.0, maxMip, dimensions), 0.0).rgb;
    return mix(first, second, fract(mip));
  }
`, [atlasUv] as unknown as NonNullable<Parameters<typeof wgslFn>[1]>);
