import * as THREE from 'three/webgpu';
import {
  Fn,
  abs,
  attribute,
  color,
  float,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalWorld,
  normalize,
  positionWorld,
  pow,
  smoothstep,
  texture,
  transformNormalToView,
  vec2,
  vec3,
} from 'three/tsl';

export interface CliffTextures {
  rockColor: THREE.Texture;
  rockNormal: THREE.Texture;
  rockRoughness: THREE.Texture;
  dirtColor: THREE.Texture;
  dirtNormal: THREE.Texture;
}

export const CLIFF_AVERAGE_COLOR = new THREE.Color(0.52, 0.44, 0.34);

/**
 * Cut face of the slab: compacted sand and soil strata with embedded rock.
 *
 * Triplanar in world space, so the displaced wall mesh needs no authored UVs. The
 * wall geometry carries a `strata` attribute (0 = soil, 1 = rock) written by the
 * displacement pass; the material blends the two texture sets along it and darkens
 * the horizontal bands that read as sediment layers.
 */
export function createCliffMaterial(tex: CliffTextures): THREE.MeshStandardNodeMaterial {
  for (const t of [tex.rockColor, tex.dirtColor]) t.colorSpace = THREE.SRGBColorSpace;
  for (const t of Object.values(tex)) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
  }

  const material = new THREE.MeshStandardNodeMaterial();
  material.color = CLIFF_AVERAGE_COLOR.clone();
  material.map = tex.dirtColor;
  material.roughness = 0.95;
  material.metalness = 0;
  material.name = 'cliff';
  material.userData.lightmapAlbedo = true;

  const p = positionWorld;
  const strata = attribute('strata', 'float');

  // Triplanar weights sharpened so the blend zone stays narrow.
  const weights = Fn(() => {
    const w = pow(abs(normalWorld), vec3(4.0));
    return w.div(w.x.add(w.y).add(w.z));
  })();

  const triColor = (t: THREE.Texture, scale: number) => {
    const s = float(scale);
    const cx = texture(t, p.zy.mul(s));
    const cy = texture(t, p.xz.mul(s));
    const cz = texture(t, p.xy.mul(s));
    return cx.rgb.mul(weights.x).add(cy.rgb.mul(weights.y)).add(cz.rgb.mul(weights.z));
  };

  // Tangent-space normal maps re-projected per plane into world space (UDN-style).
  const triNormal = (t: THREE.Texture, scale: number, strength: number) => {
    const s = float(scale);
    const nx = texture(t, p.zy.mul(s)).rgb.mul(2.0).sub(1.0);
    const ny = texture(t, p.xz.mul(s)).rgb.mul(2.0).sub(1.0);
    const nz = texture(t, p.xy.mul(s)).rgb.mul(2.0).sub(1.0);
    const n = normalWorld;
    const wx = vec3(n.x, nx.y.mul(strength).add(n.y), nx.x.mul(strength).add(n.z));
    const wy = vec3(ny.x.mul(strength).add(n.x), n.y, ny.y.mul(strength).add(n.z));
    const wz = vec3(nz.x.mul(strength).add(n.x), nz.y.mul(strength).add(n.y), n.z);
    return normalize(wx.mul(weights.x).add(wy.mul(weights.y)).add(wz.mul(weights.z)));
  };

  // The dirt map only lends its texture: its own green-brown hue is replaced by
  // compacted coral sand, which is what this slab is cut from.
  const soilTexture = triColor(tex.dirtColor, 0.55);
  const soilLuma = soilTexture.r.mul(0.3).add(soilTexture.g.mul(0.59)).add(soilTexture.b.mul(0.11));
  // Pale compacted sand near the top, darker packed earth toward the underside.
  const soilTint = mix(color(0.46, 0.36, 0.25), color(0.80, 0.66, 0.46), smoothstep(-2.6, -0.4, p.y));
  const soil = soilTint.mul(soilLuma.mul(2.4).add(0.35));
  // Rock030 averages 0.08 linear; lift it to the pale limestone of the reference.
  const rock = triColor(tex.rockColor, 0.45).mul(color(4.6, 4.3, 3.9)).clamp(0.0, 0.9);
  const rockMask = smoothstep(0.3, 0.7, strata);

  // Sediment bands: dark thin lines at varying y, wobbling with x/z.
  const bandCoord = p.y.mul(9.0).add(mx_noise_float(p.mul(0.8)).mul(1.5));
  const bands = smoothstep(0.35, 0.5, abs(bandCoord.fract().sub(0.5)));
  const bandDark = mix(float(0.62), float(1.0), bands);
  const mottle = mx_fractal_noise_float(p.mul(1.3), 3).mul(0.12).add(1.0);

  // Sand crust at the top of the wall, where the beach surface turns over the edge.
  const crust = smoothstep(-0.6, 0.15, p.y).mul(rockMask.oneMinus());
  const sand = color(0.84, 0.72, 0.52);

  const albedoBase = mix(soil.mul(bandDark), rock, rockMask).mul(mottle);
  const albedo = mix(albedoBase, sand.mul(mottle), crust.mul(0.8));
  material.colorNode = albedo;

  const roughRock = texture(tex.rockRoughness, p.xy.mul(0.45)).r;
  material.roughnessNode = mix(float(0.95), roughRock.mul(0.3).add(0.65), rockMask);

  const nSoil = triNormal(tex.dirtNormal, 0.55, 0.6);
  const nRock = triNormal(tex.rockNormal, 0.45, 1.0);
  material.normalNode = transformNormalToView(normalize(mix(nSoil, nRock, rockMask)));

  // Touch vec2 so the import is not unused in some tree-shaken build.
  void vec2;
  return material;
}
