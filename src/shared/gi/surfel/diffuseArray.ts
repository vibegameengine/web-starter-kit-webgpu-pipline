// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
// diffuseArray.ts
import * as THREE from 'three/webgpu';
import { oneMinus, texture, uniform, uv, vec2, vec4 } from 'three/tsl';

type MatLike = THREE.Material & { map?: THREE.Texture; color?: THREE.Color };

export type DiffuseArrayResult = {
  diffuseArrayTex: THREE.Texture;
  materialIdByUUID: Map<string, number>;
  materialCount: number;
};

function getMaterialColorLinear(mat: THREE.Material): THREE.Color {
  const m = mat as MatLike;
  return (m.color && (m.color as any).isColor) ? m.color : new THREE.Color(1, 1, 1);
}

function getMaterialMap(mat: THREE.Material): THREE.Texture | null {
  const m = mat as MatLike;
  return m.map ?? null;
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

export function buildDiffuseArrayTexture(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  layerSize = 1024
): DiffuseArrayResult {
  // 1) Collect unique materials
  const materialIdByUUID = new Map<string, number>();
  const materials: THREE.Material[] = [];

  scene.traverse(obj => {
    if (!(obj instanceof THREE.Mesh) || !obj.visible) return;

    const mesh = obj as THREE.Mesh;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

    for (const m of mats) {
      if (!m) continue;
      if (!materialIdByUUID.has(m.uuid)) {
        materialIdByUUID.set(m.uuid, materials.length);
        materials.push(m);
      }
    }
  });

  const materialCount = Math.max(1, materials.length);
  const arrayLayerCount = Math.max(2, materialCount);

  // 2) Create array render target for baking
  const renderTarget = new THREE.RenderTarget(layerSize, layerSize, {
    depth: arrayLayerCount,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false
  });

  const diffuseArrayTex = renderTarget.texture;
  diffuseArrayTex.wrapS = diffuseArrayTex.wrapT = THREE.RepeatWrapping;
  diffuseArrayTex.minFilter = THREE.LinearFilter;
  diffuseArrayTex.magFilter = THREE.LinearFilter;
  diffuseArrayTex.generateMipmaps = false;
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

  for (let layer = 0; layer < arrayLayerCount; layer++) {
    const mat = layer < materialCount ? materials[layer] : null;
    const baseColor = mat ? getMaterialColorLinear(mat) : fallbackColor;
    const map = mat ? getMaterialMap(mat) : null;

    baseColorUniform.value.copy(baseColor);
    const mapTex = isTextureReady(map) ? map : whiteMap;
    mapTex.updateMatrix?.();
    mapNode.value = mapTex;

    renderer.setRenderTarget(renderTarget, layer);
    renderer.render(bakeScene, bakeCamera);
  }

  renderer.setRenderTarget(prevTarget, prevLayer, prevMip);

  return { diffuseArrayTex, materialIdByUUID, materialCount };
}
