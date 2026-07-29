// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
// diffuseArray.ts
import * as THREE from 'three/webgpu';
import { oneMinus, texture, uniform, uv, vec2, vec4 } from 'three/tsl';

type MatLike = THREE.Material & {
  map?: THREE.Texture;
  color?: THREE.Color;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
  emissiveMap?: THREE.Texture;
};

export type DiffuseArrayResult = {
  diffuseArrayTex: THREE.Texture;
  materialIdByUUID: Map<string, number>;
  materialCount: number;
  /** Layers actually allocated — materials that look the same share one. */
  layerCount: number;
  /** Edge of one layer in texels. Derived from the source maps, not assumed. */
  layerSize: number;
  /** Levels in the chain, so the tracer knows what it is allowed to ask for. */
  mipLevels: number;
  bytes: number;
  /**
   * Layer holding material 0's emission, or -1 when nothing in the scene emits.
   * A hit's emissive layer is `emissiveBase + matId`; see hitShading.ts for why this
   * shares the albedo array instead of getting one of its own.
   */
  emissiveBase: number;
  /**
   * What a full-white emissive texel in that layer means, in radiance.
   *
   * The layers are RGBA8, so a material emitting at 40 and one emitting at 4 cannot
   * both be stored literally. They are stored *relative* to the brightest emitter in
   * the scene and this is that brightest value, applied as one multiply in the shader.
   * The ratio between two emitters therefore survives exactly; what does not survive is
   * a scene whose emitters differ by more than 255:1, where the dim one quantises to
   * black. That case is loud in the log below rather than silent.
   */
  emissiveScale: number;
};

/**
 * Ceiling on one layer's edge.
 *
 * Not a resolution target — a refusal. This array is read by *rays*, and a bounce
 * carries a surface's average albedo over a footprint that is metres across by the
 * time it matters. The terrain here bakes a repeat of 16.7 into a single layer, so
 * even at 1024 one tile of the source grass got 61 texels; the detail this cap is
 * accused of throwing away was already gone. What 1024 bought was 4 MiB per
 * material, which is a real cost paid for nothing.
 */
export const DIFFUSE_LAYER_MAX = 512;

/** Below this a layer costs less than the bookkeeping to special-case it. */
export const DIFFUSE_LAYER_MIN = 32;

/**
 * Quantisation applied to a material's tint before two materials are called the same.
 *
 * Steps are taken in the *display* domain rather than linear, because that is where
 * equal steps look equal; quantising linear values would collapse the whole dark end
 * of the range into one bucket and leave the bright end over-resolved. 32 steps is
 * ~3 % per channel, which is below what a single bounce of indirect light can carry
 * out of this array and into a pixel.
 */
const TINT_QUANTISATION = 32;

function getMaterialColorLinear(mat: THREE.Material): THREE.Color {
  const m = mat as MatLike;
  return (m.color && (m.color as any).isColor) ? m.color : new THREE.Color(1, 1, 1);
}

function getMaterialMap(mat: THREE.Material): THREE.Texture | null {
  const m = mat as MatLike;
  return m.map ?? null;
}

function getMaterialEmissiveMap(mat: THREE.Material): THREE.Texture | null {
  const m = mat as MatLike;
  return m.emissiveMap ?? null;
}

/**
 * A material's emission as linear RGB, intensity folded in.
 *
 * `emissiveIntensity` defaults to 1 on a standard material even when `emissive` is
 * black, so the colour is what decides whether anything is emitting — multiplying by an
 * intensity nobody set would turn every material in the scene into a light of zero
 * brightness and double the array for it.
 */
function getMaterialEmissive(mat: THREE.Material): THREE.Color {
  const m = mat as MatLike;
  const emissive = m.emissive && (m.emissive as any).isColor ? m.emissive : null;
  if (!emissive) return new THREE.Color(0, 0, 0);
  const intensity = typeof m.emissiveIntensity === 'number' ? m.emissiveIntensity : 1;
  return emissive.clone().multiplyScalar(Math.max(0, intensity));
}

function emissivePeak(colour: THREE.Color): number {
  return Math.max(colour.r, colour.g, colour.b);
}

function isTextureReady(tex: THREE.Texture | null): tex is THREE.Texture {
  if (!tex) return false;
  const image = (tex as any).image ?? (tex as any).source?.data;
  return !!image;
}

function createWhiteTexture(): THREE.DataTexture {
  const data = new Uint8Array([255, 255, 255, 255]);
  const tex = new THREE.DataTexture(data, 1, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Largest edge of the image behind a texture, or 0 when there is nothing to read. */
function sourceEdge(tex: THREE.Texture | null): number {
  if (!isTextureReady(tex)) return 0;
  const image = (tex as any).image ?? (tex as any).source?.data;
  const w = image?.width ?? 0;
  const h = image?.height ?? 0;
  return Math.max(w, h);
}

function ceilPow2(v: number): number {
  if (v <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(v));
}

/**
 * What makes two materials indistinguishable *to a ray*.
 *
 * The map identity and its matrix have to match exactly — a different repeat is a
 * different image once it is baked flat into a layer. The tint only has to match to
 * within a step, per the note on TINT_QUANTISATION. The terrain in the large scene
 * is sixteen materials over one 2K map that differ by nothing else, and every one of
 * them was costing 4 MiB of its own.
 */
function appearanceKey(mat: THREE.Material): string {
  const map = getMaterialMap(mat);
  const colour = getMaterialColorLinear(mat);
  // sqrt is a gamma 2.0 stand-in: close enough to sRGB for a bucket boundary, and
  // unlike a real transfer function it cannot disagree with the renderer's colour
  // management about which working space this Color is in.
  const q = (v: number) =>
    Math.round(Math.min(1, Math.sqrt(Math.max(0, v))) * TINT_QUANTISATION);

  // Emission joins the key, unquantised and unbucketed. Two materials that look
  // identical but only one of which is a light are not the same material to a ray, and
  // collapsing them would put a lamp's glow on every wall that shares its albedo.
  const emissive = getMaterialEmissive(mat);
  const emissiveMap = getMaterialEmissiveMap(mat);
  const emissiveKey =
    emissivePeak(emissive) > 0 || isTextureReady(emissiveMap)
      ? `|e${emissive.r},${emissive.g},${emissive.b},${emissiveMap?.uuid ?? '-'}`
      : '';

  if (!isTextureReady(map)) {
    return `flat|${q(colour.r)}|${q(colour.g)}|${q(colour.b)}${emissiveKey}`;
  }

  const m = map.matrix?.elements;
  const matrixKey = m
    ? m.map((v: number) => Math.round(v * 4096)).join(',')
    : `${map.repeat.x},${map.repeat.y},${map.offset.x},${map.offset.y},${map.rotation}`;
  return `${map.uuid}|${matrixKey}|${q(colour.r)}|${q(colour.g)}|${q(colour.b)}${emissiveKey}`;
}

export function buildDiffuseArrayTexture(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  layerSizeCap = DIFFUSE_LAYER_MAX
): DiffuseArrayResult {
  // 1) Collect unique materials, then collapse the ones that look alike.
  //
  // `materialIdByUUID` still maps a material straight onto the *layer* it is drawn
  // into, which is what keeps this change invisible to every consumer: the matId
  // packed per triangle in sceneBvh.ts, the dynamic BVH's copy of the same table, and
  // the screen-probe pass all index the array by that number and none of them has to
  // learn that two materials can now answer with the same one.
  const materialIdByUUID = new Map<string, number>();
  const layerByKey = new Map<string, number>();
  const layerMaterial: THREE.Material[] = [];
  const seenMaterials = new Set<string>();
  let materialCount = 0;
  let maxSourceEdge = 0;

  scene.traverse(obj => {
    if (!(obj instanceof THREE.Mesh) || !obj.visible) return;

    // `InstancedMesh extends Mesh` and reaches here, which is correct: every instance
    // shares the one material, so there is nothing to expand. That is only true of this
    // pass — the geometry gather in sceneBvh.ts had the same shape and was wrong there,
    // because instances do *not* share a transform.
    const mesh = obj as THREE.Mesh;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

    for (const m of mats) {
      if (!m) continue;
      if (seenMaterials.has(m.uuid)) continue;
      seenMaterials.add(m.uuid);
      materialCount++;

      const map = getMaterialMap(m);
      map?.updateMatrix?.();
      maxSourceEdge = Math.max(maxSourceEdge, sourceEdge(map));

      const key = appearanceKey(m);
      let layer = layerByKey.get(key);
      if (layer === undefined) {
        layer = layerMaterial.length;
        layerByKey.set(key, layer);
        layerMaterial.push(m);
      }
      materialIdByUUID.set(m.uuid, layer);
    }
  });

  // 2) Size the layer against what is actually in the scene.
  //
  // A world of 128² textures gets a 128² array. The cap only binds when the sources
  // are larger than a bounce can use, which is the case here and is the whole reason
  // the old fixed 1024 was 124 MiB.
  const wanted = maxSourceEdge > 0 ? ceilPow2(maxSourceEdge) : DIFFUSE_LAYER_MIN;
  const layerSize = Math.min(
    Math.max(wanted, DIFFUSE_LAYER_MIN),
    Math.max(DIFFUSE_LAYER_MIN, layerSizeCap),
  );

  const albedoLayers = Math.max(2, layerMaterial.length);
  const mipLevels = Math.floor(Math.log2(layerSize)) + 1;

  // 2b) Emission, if there is any.
  //
  // The array doubles only when something in the scene actually emits. It is not a
  // free doubling — 20 layers at 512² is 26 MiB — and a forest with no lamps in it
  // should not pay for the ability to have one.
  let emissiveScale = 0;
  for (const mat of layerMaterial) {
    emissiveScale = Math.max(emissiveScale, emissivePeak(getMaterialEmissive(mat)));
    if (isTextureReady(getMaterialEmissiveMap(mat))) emissiveScale = Math.max(emissiveScale, 1);
  }
  const hasEmissive = emissiveScale > 0;
  const emissiveBase = hasEmissive ? albedoLayers : -1;
  const layerCount = hasEmissive ? albedoLayers * 2 : albedoLayers;

  // 3) Create array render target for baking
  const renderTarget = new THREE.RenderTarget(layerSize, layerSize, {
    depth: layerCount,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    // Mips are not a size optimisation here, they are a correctness one. Without them
    // every ray hit reads the top level, so a hit 200 m away point-samples a full-rate
    // texture; the resulting per-sample noise is read by MSME as variance and clamped
    // as a firefly, which suppresses light that was never wrong in the first place.
    generateMipmaps: true,
    depthBuffer: false,
    stencilBuffer: false
  });

  const diffuseArrayTex = renderTarget.texture;
  diffuseArrayTex.wrapS = diffuseArrayTex.wrapT = THREE.RepeatWrapping;
  diffuseArrayTex.minFilter = THREE.LinearMipmapLinearFilter;
  diffuseArrayTex.magFilter = THREE.LinearFilter;
  diffuseArrayTex.generateMipmaps = true;
  diffuseArrayTex.name = 'DiffuseArrayTex';

  const whiteMap = createWhiteTexture();

  const bakeScene = new THREE.Scene();
  const bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  bakeCamera.position.set(0, 0, 1);
  bakeCamera.lookAt(0, 0, 0);

  const bakeMaterial = new THREE.MeshBasicNodeMaterial({
    color: new THREE.Color(1, 1, 1),
    map: whiteMap,
  });
  bakeMaterial.toneMapped = false;
  bakeMaterial.depthTest = false;
  bakeMaterial.depthWrite = false;
  bakeMaterial.map = null;

  const baseColorUniform = uniform(new THREE.Color(1, 1, 1));
  const flippedUv = vec2(uv().x, oneMinus(uv().y));
  const mapNode = texture(whiteMap, flippedUv).setUpdateMatrix(true);
  bakeMaterial.colorNode = vec4(mapNode.rgb.mul(baseColorUniform), 1.0);

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bakeMaterial);
  quad.frustumCulled = false;
  bakeScene.add(quad);

  const prevTarget = renderer.getRenderTarget();
  const prevLayer = renderer.getActiveCubeFace();
  const prevMip = renderer.getActiveMipmapLevel();
  const fallbackColor = new THREE.Color(1, 1, 1);

  for (let layer = 0; layer < layerCount; layer++) {
    const isEmissiveLayer = hasEmissive && layer >= albedoLayers;
    const sourceIndex = isEmissiveLayer ? layer - albedoLayers : layer;
    const mat = sourceIndex < layerMaterial.length ? layerMaterial[sourceIndex] : null;

    // Emission is stored relative to the brightest emitter (see `emissiveScale` on the
    // result type): the layer is RGBA8 and cannot hold a radiance of 40 any other way.
    const baseColor = isEmissiveLayer
      ? mat
        ? getMaterialEmissive(mat).multiplyScalar(1 / emissiveScale)
        : new THREE.Color(0, 0, 0)
      : mat
        ? getMaterialColorLinear(mat)
        : fallbackColor;
    const map = mat
      ? isEmissiveLayer
        ? getMaterialEmissiveMap(mat)
        : getMaterialMap(mat)
      : null;

    baseColorUniform.value.copy(baseColor);
    const mapTex = isTextureReady(map) ? map : whiteMap;
    mapTex.updateMatrix?.();
    mapNode.value = mapTex;

    // The backend regenerates the whole array's chain after *every* render into it, so
    // leaving the flag up for all N passes rebuilds every level N times over. The first
    // pass has to see it up — that is when the GPU texture descriptor is created and the
    // level count is fixed — and the last pass is the one whose chain survives.
    diffuseArrayTex.generateMipmaps = layer === 0 || layer === layerCount - 1;

    renderer.setRenderTarget(renderTarget, layer);
    renderer.render(bakeScene, bakeCamera);
  }

  diffuseArrayTex.generateMipmaps = true;
  renderer.setRenderTarget(prevTarget, prevLayer, prevMip);

  // Mip chain adds a third; still an order of magnitude under one flat 1024 per material.
  const bytes = Math.round(layerCount * layerSize * layerSize * 4 * (4 / 3));

  console.log(
    `[diffuseArray] ${materialCount} materials → ${albedoLayers} albedo layers ` +
      `(${materialCount - albedoLayers} deduplicated)` +
      (hasEmissive ? ` + ${albedoLayers} emissive layers` : ', no emissive') +
      `, ${layerSize}² × ${mipLevels} mips, ` +
      `${(bytes / 1048576).toFixed(1)} MiB — sources up to ${maxSourceEdge}²`,
  );

  if (hasEmissive) {
    const emitters = layerMaterial.filter(
      (m) => emissivePeak(getMaterialEmissive(m)) > 0 || isTextureReady(getMaterialEmissiveMap(m)),
    );
    const dimmest = Math.min(
      ...emitters.map((m) => emissivePeak(getMaterialEmissive(m)) || 1),
    );
    console.log(
      `[diffuseArray] ${emitters.length} emissive material(s), peak radiance ` +
        `${emissiveScale.toFixed(3)} stored as layer ${emissiveBase}..${layerCount - 1}`,
    );
    if (dimmest > 0 && emissiveScale / dimmest > 255) {
      console.error(
        `[diffuseArray] emissive dynamic range is ${(emissiveScale / dimmest).toFixed(0)}:1 ` +
          'and an RGBA8 layer holds 255:1. The dimmest emitter quantises to black and ' +
          'will contribute NO indirect light. Split the scene or raise the dim emitter.',
      );
    }
  }

  return {
    diffuseArrayTex,
    materialIdByUUID,
    materialCount,
    layerCount,
    layerSize,
    mipLevels,
    bytes,
    emissiveBase,
    emissiveScale,
  };
}
