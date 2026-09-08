import { uniform, wgslFn } from 'three/tsl';

/** Runtime comparison only; it does not change or invalidate the baked radiance. */
export const U_BAKED_LOD_OVERRIDE = uniform(-1);

// Ray-cone projection onto a triangle, followed by its actual world-to-atlas
// Jacobian. Inspired by Akenine-Moller et al., JCGT 10(1), 2021; original code.
// Uses the largest ellipse axis for an isotropic trilinear footprint. This is
// conservative on grazing/stretched triangles, not anisotropic filtering.
export const BAKED_HIT_LOD_WGSL = /* wgsl */ `
  fn bakedHitLod(p0: vec3f, p1: vec3f, p2: vec3f,
    uv0: vec2f, uv1: vec2f, uv2: vec2f, direction: vec3f,
    diameter: f32, atlasSize: f32, maxLod: f32) -> f32 {
    let e1 = p1 - p0;
    let e2 = p2 - p0;
    let areaVector = cross(e1, e2);
    let area = length(areaVector);
    if (area < 1e-12) { return maxLod; }
    let n = areaVector / area;
    let duv1 = uv1 - uv0;
    let duv2 = uv2 - uv0;
    let dual1 = cross(e2, n) / area;
    let dual2 = cross(n, e1) / area;
    let gu = duv1.x * dual1 + duv2.x * dual2;
    let gv = duv1.y * dual1 + duv2.y * dual2;
    let nd = dot(n, direction);
    let safeNd = select(-1.0, 1.0, nd >= 0.0) * max(abs(nd), 1e-4);
    // Extend the plane gradients along the ray onto its perpendicular disc.
    let u = gu - n * (dot(gu, direction) / safeNd);
    let v = gv - n * (dot(gv, direction) / safeNd);
    let uu = dot(u, u);
    let vv = dot(v, v);
    let uv = dot(u, v);
    let largest = 0.5 * (uu + vv + sqrt(max(0.0, (uu - vv) * (uu - vv) + 4.0 * uv * uv)));
    let texels = max(0.0, diameter) * atlasSize * sqrt(max(0.0, largest));
    return clamp(log2(max(1.0, texels)), 0.0, maxLod);
  }
`;
export const bakedHitLod = wgslFn(BAKED_HIT_LOD_WGSL);
