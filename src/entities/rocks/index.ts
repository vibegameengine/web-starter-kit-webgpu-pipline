import * as THREE from 'three/webgpu';
import {
  Fn,
  abs,
  attribute,
  clamp,
  float,
  mix,
  mx_noise_float,
  normalWorldGeometry,
  positionWorld,
  pow,
  sign,
  smoothstep,
  texture,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { createRockGeometry } from './rockGeometry';

export interface RockTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  aoMap: THREE.Texture;
}

export interface RockOptions {
  seed: number;
  /** Metres. */
  radius: number;
  /** Anisotropic stretch, default derived from seed. */
  scale?: THREE.Vector3Like;
  /** 0..1, default 0.6. */
  sharpness?: number;
  /** Mossy / darker tint. Only informative here; the tint lives on the material. */
  submerged?: boolean;
}

export type RockVariant = 'dry' | 'submerged';

/** Colour tiling in repeats per metre (world space). */
const COLOR_REPEATS_PER_METRE = 0.6;

/**
 * Target mean albedo per variant, as an sRGB colour (what the boulder should
 * read as under flat light: warm light grey-beige / dark mossy green-brown).
 */
const TARGET_ALBEDO_SRGB: Record<RockVariant, [number, number, number]> = {
  dry: [0.74, 0.69, 0.62],
  submerged: [0.32, 0.36, 0.28],
};

/**
 * Measured mean linear albedo of Rock030_2K Color (it is a dark texture,
 * sRGB mean 0.31). `material.color` is target / mean so that map * color
 * lands on the target in both the raster and any map-sampling ray tracer.
 */
const ROCK030_MEAN_ALBEDO_LINEAR: [number, number, number] = [0.081, 0.076, 0.063];

/** Albedo ceiling: a few bright texels exceed 1 after normalisation. */
const ALBEDO_MAX = 0.95;

/** Tangent-space normal map strength for the triplanar normal. */
const NORMAL_STRENGTH = 0.7;

function tintFor(variant: RockVariant): THREE.Color {
  const t = TARGET_ALBEDO_SRGB[variant];
  const c = new THREE.Color().setRGB(t[0], t[1], t[2], THREE.SRGBColorSpace);
  const m = ROCK030_MEAN_ALBEDO_LINEAR;
  return c.setRGB(c.r / m[0], c.g / m[1], c.b / m[2], THREE.LinearSRGBColorSpace);
}

/**
 * World-space triplanar sampling. Weights are |n|^4 renormalised so blend
 * zones stay narrow. UVs are sign-flipped per plane so the back sides are not
 * mirrored (needed for the normal map, harmless for colour).
 */
function triplanarUVs(scale: number) {
  const p = positionWorld.mul(scale);
  const n = normalWorldGeometry;
  const axisSign = sign(n);
  const w4 = pow(abs(n), 4.0);
  const w = w4.div(w4.x.add(w4.y).add(w4.z));
  const uvX = vec2(p.z.mul(axisSign.x), p.y);
  const uvY = vec2(p.x.mul(axisSign.y), p.z);
  const uvZ = vec2(p.x.mul(axisSign.z.negate()), p.y);
  return { uvX, uvY, uvZ, w, n, axisSign };
}

export function createRockMaterial(textures: RockTextures, variant: RockVariant): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = `rock-${variant}`;
  // Plain-material fields: what a uv-based ray tracer reads.
  material.map = textures.map;
  material.color.copy(tintFor(variant));
  material.roughness = variant === 'submerged' ? 0.9 : 0.85;
  material.metalness = 0;

  const submerged = variant === 'submerged';
  const tri = triplanarUVs(COLOR_REPEATS_PER_METRE);
  // Plain tint uniform. NOT `materialColor`: that node already includes
  // `material.map` sampled by uv, which would multiply the map in twice.
  const tint = uniform(material.color);
  const crevice = attribute('crevice', 'float');

  // ---- albedo ----------------------------------------------------------
  const albedo = Fn(() => {
    const cX = texture(textures.map, tri.uvX).rgb.mul(tri.w.x);
    const cY = texture(textures.map, tri.uvY).rgb.mul(tri.w.y);
    const cZ = texture(textures.map, tri.uvZ).rgb.mul(tri.w.z);
    const tinted = cX.add(cY).add(cZ).mul(tint);

    // Macro variation: big soft blotches so 0.6 rpm tiling never reads as a pattern.
    const macro = mx_noise_float(positionWorld.mul(0.7)).mul(0.15).add(1.0);
    // Crevices are dark: dust, shadowed cracks.
    const c = clamp(tinted.mul(clamp(macro, 0.85, 1.15)).mul(float(1.0).sub(crevice.mul(0.35))), 0.0, ALBEDO_MAX);

    if (!submerged) return c;

    // Faint moss patches, mostly on faces that catch light/sediment.
    const patch = smoothstep(0.15, 0.6, mx_noise_float(positionWorld.mul(2.3)));
    const upward = smoothstep(-0.2, 0.7, tri.n.y);
    const moss = patch.mul(upward).mul(0.3);
    const mossColour = c.mul(vec3(0.7, 0.9, 0.5));
    return mix(c, mossColour, moss);
  })();

  // ---- normal (world-space whiteout triplanar → view space) --------------
  const normalView = Fn(() => {
    const n = tri.n;
    const s = tri.axisSign;
    const unpack = (t: THREE.Node) => t.mul(2.0).sub(1.0);

    const tX = unpack(texture(textures.normalMap, tri.uvX).xyz).toVar();
    const tY = unpack(texture(textures.normalMap, tri.uvY).xyz).toVar();
    const tZ = unpack(texture(textures.normalMap, tri.uvZ).xyz).toVar();

    // Undo the uv flip on the tangent x so the map's slopes face the right way.
    tX.x.mulAssign(s.x);
    tY.x.mulAssign(s.y);
    tZ.x.mulAssign(s.z.negate());

    // Whiteout blend with the geometric normal swizzled into each tangent frame.
    const wX = vec3(tX.xy.mul(NORMAL_STRENGTH).add(vec2(n.z, n.y)), abs(tX.z).mul(n.x));
    const wY = vec3(tY.xy.mul(NORMAL_STRENGTH).add(vec2(n.x, n.z)), abs(tY.z).mul(n.y));
    const wZ = vec3(tZ.xy.mul(NORMAL_STRENGTH).add(vec2(n.x, n.y)), abs(tZ.z).mul(n.z));

    // Swizzle each tangent-frame result back into world axes and blend.
    const world = wX.zyx.mul(tri.w.x).add(wY.xzy.mul(tri.w.y)).add(wZ.xyz.mul(tri.w.z)).normalize();
    // `transformDirection(v, cameraViewMatrix)` is TSL's view->world (it is how
    // `normalWorld` is defined); world->view is the dedicated helper.
    return transformNormalToView(world);
  })();

  // ---- roughness / ao -----------------------------------------------------
  const roughness = Fn(() => {
    const rX = texture(textures.roughnessMap, tri.uvX).r.mul(tri.w.x);
    const rY = texture(textures.roughnessMap, tri.uvY).r.mul(tri.w.y);
    const rZ = texture(textures.roughnessMap, tri.uvZ).r.mul(tri.w.z);
    const r = rX.add(rY).add(rZ);
    const base = submerged ? mix(float(0.86), float(1.0), r) : mix(float(0.75), float(1.0), r);
    return clamp(base.add(crevice.mul(0.15)), 0.0, 1.0);
  })();

  const ao = Fn(() => {
    const aX = texture(textures.aoMap, tri.uvX).r.mul(tri.w.x);
    const aY = texture(textures.aoMap, tri.uvY).r.mul(tri.w.y);
    const aZ = texture(textures.aoMap, tri.uvZ).r.mul(tri.w.z);
    return aX.add(aY).add(aZ);
  })();

  material.colorNode = albedo;
  material.normalNode = normalView;
  material.roughnessNode = roughness;
  material.aoNode = ao;
  return material;
}

export function createRock(options: RockOptions, material: THREE.MeshStandardNodeMaterial): THREE.Mesh {
  const geometry = createRockGeometry({
    seed: options.seed,
    radius: options.radius,
    scale: options.scale,
    sharpness: options.sharpness,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'rock';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export { createRockGeometry } from './rockGeometry';
export type { RockGeometryOptions } from './rockGeometry';
