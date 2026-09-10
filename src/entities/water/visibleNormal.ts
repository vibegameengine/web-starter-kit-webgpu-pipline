import { wgslFn } from 'three/tsl';

export const visibleWaterNormal = wgslFn(`
  fn visibleWaterNormal(shading: vec3f, geometric: vec3f, view: vec3f) -> vec3f {
    let limit = min(0.01, max(0.0, dot(geometric, view)) * 0.9);
    if (dot(shading, view) > 0.0 && dot(reflect(-view, shading), geometric) >= limit) { return shading; }
    var low = 0.0;
    var high = 1.0;
    for (var i = 0u; i < 12u; i++) {
      let mid = (low + high) * 0.5;
      let candidate = normalize(mix(shading, geometric, mid));
      if (dot(candidate, view) > 0.0 && dot(reflect(-view, candidate), geometric) >= limit) { high = mid; }
      else { low = mid; }
    }
    return normalize(mix(shading, geometric, high));
  }
`);
