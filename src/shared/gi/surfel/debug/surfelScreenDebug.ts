// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
// surfelScreenDebug.ts
import * as THREE from 'three/webgpu';
import {
  Fn,
  Loop,
  If,
  abs,
  dot,
  float,
  getViewPosition,
  int,
  length,
  max,
  min,
  oneMinus,
  sampler,
  smoothstep,
  storage,
  texture as tslTexture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  instanceIndex,
  uint,
  fract,
  atomicLoad,
  wgslFn,
  normalize,
  cross,
  select,
} from 'three/tsl';
import { SurfelMoments, SurfelStruct, type SurfelPool } from '../surfelPool';
import {
  snap_to_surfel_grid_origin,
  surfel_grid_c4_to_hash,
  surfel_grid_coord_to_c4,
  surfel_pos_to_grid_coord,
  surfel_radius_for_pos,
  type SurfelHashGrid,
} from '../surfelHashGrid';
import {
  SLG_LOBE_COUNT,
  SLG_TOTAL_FLOATS,
  SURFEL_DEPTH_TEXELS,
  SURFEL_LIFE_RECYCLE,
  SURFEL_NORMAL_DIRECTION_SQUISH,
  SURFEL_RADIUS_OVERSCALE,
  OFFSETS_AND_LIST_START,
} from '../constants';
import type GUI from 'lil-gui';
import type { SurfelFindMissingPass } from '../surfelFindMissingPass';
import {
  point_sample_radial_depth,
  surfelRadialDepthOcclusion,
  U_OCCLUSION_PARAMS,
} from '../surfelRadialDepth';
import { hemiOctSquareEncode } from '../surfelIntegratePass';
import { resolveIrradiance } from '../surfelGIResolvePass';
import type { SceneBVHBundle } from '../sceneBvh';
import {
  bvhIntersectFirstHit,
  getVertexAttribute,
  rayStruct,
  constants,
} from '../../bvh/webgpu/index.js';

export const SCREEN_DEBUG_MODES = {
  Off: 0,
  Surfels: 1,
  Irradiance: 2,
  Heatmap: 3,
  Cascades: 4,
  CellHash: 5,
  GridCoords: 6,
  WorldPos: 7,
  Depth: 8,
  Normals: 9,
  Albedo: 10,
  Coverage: 11,
  SLGGrid: 12,
  SpawnDespawn: 13,
  RadialOcclusion: 14,
  RadialDepthTile: 15,
  Variance: 16,
  AlbedoBVH: 17,
  AlbedoMatch: 18,
} as const;

const SCREEN_DEBUG_MODE_LIST = [
  ['Off', SCREEN_DEBUG_MODES.Off],
  ['Surfels', SCREEN_DEBUG_MODES.Surfels],
  ['Irradiance', SCREEN_DEBUG_MODES.Irradiance],
  ['Variance', SCREEN_DEBUG_MODES.Variance],
  ['Heatmap', SCREEN_DEBUG_MODES.Heatmap],
  ['Cascades', SCREEN_DEBUG_MODES.Cascades],
  ['Cell Hash', SCREEN_DEBUG_MODES.CellHash],
  ['Grid Coords', SCREEN_DEBUG_MODES.GridCoords],
  ['World Pos', SCREEN_DEBUG_MODES.WorldPos],
  ['Depth', SCREEN_DEBUG_MODES.Depth],
  ['Normals', SCREEN_DEBUG_MODES.Normals],
  ['Albedo', SCREEN_DEBUG_MODES.Albedo],
  ['Albedo BVH', SCREEN_DEBUG_MODES.AlbedoBVH],
  ['Albedo Match', SCREEN_DEBUG_MODES.AlbedoMatch],
  ['Coverage', SCREEN_DEBUG_MODES.Coverage],
  ['SLG Grid', SCREEN_DEBUG_MODES.SLGGrid],
  ['Spawn/Despawn', SCREEN_DEBUG_MODES.SpawnDespawn],
  ['Radial Occlusion', SCREEN_DEBUG_MODES.RadialOcclusion],
  ['Radial Depth Tile', SCREEN_DEBUG_MODES.RadialDepthTile],
] as const;

const SCREEN_DEBUG_MODE_OPTIONS = Object.fromEntries(SCREEN_DEBUG_MODE_LIST);

export type ScreenDebugMode =
  (typeof SCREEN_DEBUG_MODES)[keyof typeof SCREEN_DEBUG_MODES];

const sampleDiffuseArray = wgslFn(/* wgsl */ `
  fn sampleDiffuseArray(
    tex: texture_2d_array<f32>,
    texSampler: sampler,
    uvIn: vec2f,
    layerIn: i32
  ) -> vec3f {
    let dims = textureDimensions(tex, 0);
    let w = max(1u, dims.x);
    let h = max(1u, dims.y);

    let layerCount = textureNumLayers(tex);
    let layer = clamp(layerIn, 0, i32(layerCount) - 1);

    let c = textureSampleLevel(tex, texSampler, uvIn, layer, 0.0);
    return c.rgb;
  }
`);

const bvhAlbedoAtRay = wgslFn(
  /* wgsl */ `
  fn bvhAlbedoAtRay(
    origin: vec3f,
    direction: vec3f,
    tex: texture_2d_array<f32>,
    texSampler: sampler
  ) -> vec4f {
    var ray: Ray;
    ray.origin = origin;
    ray.direction = direction;

    let hit = bvhIntersectFirstHit(ray);
    if (hit.didHit) {
      let uvMat = getVertexAttribute(hit.barycoord, hit.indices.xyz);
      let matId = i32(round(uvMat.z));
      let albedo = sampleDiffuseArray(tex, texSampler, uvMat.xy, matId);
      return vec4f(albedo, 1.0);
    }

    return vec4f(0.0, 0.0, 0.0, 0.0);
  }
`,
  [bvhIntersectFirstHit, getVertexAttribute, sampleDiffuseArray, rayStruct, constants],
);

export function createSurfelScreenDebug(
  grid: SurfelHashGrid,
  pool: SurfelPool,
) {
  // ---------- resources ----------
  let overlayAttr: THREE.StorageBufferAttribute | null = null; // vec4 per pixel
  let overlayStore: THREE.StorageBufferNode | null = null;
  let tileAllocAttr: THREE.StorageBufferAttribute | null = null;
  let quad: THREE.QuadMesh | null = null;
  let blitMat: THREE.NodeMaterial | null = null;
  let blitWidth = 0;
  let blitHeight = 0;

  let lastSurfelsAttr: THREE.StorageBufferAttribute | null = null;
  let lastMomentsAttr: THREE.StorageBufferAttribute | null = null;
  let lastOffsetsAndListAttr: THREE.StorageBufferAttribute | null = null;
  let lastSurfelDepthAttr: THREE.StorageBufferAttribute | null = null;
  let lastPixels = 0;
  let lastBvhNode: THREE.StorageBufferNode | null = null;
  let lastBvhPositionNode: THREE.StorageBufferNode | null = null;
  let lastBvhIndexNode: THREE.StorageBufferNode | null = null;
  let lastBvhColorNode: THREE.StorageBufferNode | null = null;
  let lastDiffuseTex: THREE.Texture | null = null;
  let lastBvhPixels = 0;

  // uniforms (same as in your generation pass)
  const U_PROJ_INV = uniform(new THREE.Matrix4());
  const U_CAM_WORLD = uniform(new THREE.Matrix4());
  const U_CAM_POS = uniform(new THREE.Vector3());
  const U_PREV_CAM_POS = uniform(new THREE.Vector3());
  const U_GRID_ORIGIN = uniform(new THREE.Vector3());
  const U_MOMENTS_OFFSET = uniform(0);

  const U_FRAME = uniform(int(0));
  const U_GRID_STRIDE = uniform(int(1));

  let debugCompute: THREE.ComputeNode | null = null;
  let debugComputeBvh: THREE.ComputeNode | null = null;
  // knobs
  let maxFetchPerPixel = 1024; // safety cap for heavy cells
  let show = false; // toggle

  function setShow(on: boolean) {
    show = on;
  }
  function setMaxFetch(k: number) {
    maxFetchPerPixel = Math.max(1, Math.floor(k));
  }

  let debugMode: ScreenDebugMode = SCREEN_DEBUG_MODES.Off;
  const U_DEBUG_MODE = uniform(debugMode);

  const debugParams = { mode: SCREEN_DEBUG_MODES.Off, varianceScale: 1.0 };
  const U_VARIANCE_SCALE = uniform(1.0);
  function setVarianceScale(v: number) {
    U_VARIANCE_SCALE.value = v;
  }

  function configureGUI(gui: GUI) {
    const debugFolder = gui.addFolder('Debug');
    debugFolder
      .add(debugParams, 'mode', SCREEN_DEBUG_MODE_OPTIONS)
      .name('Mode')
      .onChange((v: number) => {
        debugParams.mode = Number(v);
        setDebugMode(debugParams.mode);
      });

    debugFolder
      .add(debugParams, 'varianceScale', 0.1, 10.0, 0.1)
      .name('Variance scale')
      .onChange((v: number) => {
        debugParams.varianceScale = Number(v);
        setVarianceScale(debugParams.varianceScale);
      });
  }
  function setDebugMode(m: ScreenDebugMode) {
    console.log('Debug mode is now', m);
    debugMode = m;
    U_DEBUG_MODE.value = debugMode;
    show = m !== SCREEN_DEBUG_MODES.Off;
  }

  function ensureOverlay(width: number, height: number) {
    const pixels = width * height;
    const needsResize =
      !overlayAttr ||
      overlayAttr.count !== pixels ||
      blitWidth !== width ||
      blitHeight !== height;
    if (needsResize) {
      overlayAttr = new THREE.StorageBufferAttribute(
        new Float32Array(pixels * 4),
        4,
      );
      overlayStore = storage(overlayAttr, 'vec4', pixels);
      debugCompute = null; // rebuild compute with the new resolution
      debugComputeBvh = null; // rebuild BVH debug compute with the new resolution
    }
    if (!quad || !blitMat || blitWidth !== width || blitHeight !== height) {
      ensureBlit(width, height);
    }
    blitWidth = width;
    blitHeight = height;
  }

  function ensureBlit(width: number, height: number) {
    blitMat = new THREE.NodeMaterial();
    blitMat.depthTest = false;
    blitMat.depthWrite = false;
    blitMat.blending = THREE.AdditiveBlending;

    blitMat.colorNode = Fn(() => {
      const Wf = float(width),
        Hf = float(height);
      const x = uv().x.mul(Wf).floor();
      const y = uv().y.mul(Hf).floor();
      const flat = y.mul(Wf).add(x).toInt();
      const val = overlayStore!.element(flat);
      return vec3(val.x, val.y, val.z);
    })();

    blitMat.opacityNode = Fn(() => {
      const Wf = float(width),
        Hf = float(height);
      const x = uv().x.mul(Wf).floor();
      const y = uv().y.mul(Hf).floor();
      const flat = y.mul(Wf).add(x).toInt();
      return overlayStore!.element(flat).w;
    })();

    quad = new THREE.QuadMesh(blitMat);
    quad.frustumCulled = false;
    quad.renderOrder = 9999;
  }

  // Original screen debug
  function run(
    renderer: THREE.WebGPURenderer,
    camera: THREE.PerspectiveCamera,
    gbuffer: { target: THREE.RenderTarget },
    find: SurfelFindMissingPass,
    prevCameraPos: THREE.Vector3,
    bvh: SceneBVHBundle,
  ) {
    if (!show) return;

    const texDepth = gbuffer.target.depthTexture;
    const texNormal = gbuffer.target.textures?.[0]; // normals
    const texAlbedo = gbuffer.target.textures?.[1]; // albedo

    if (!texDepth || !texNormal || !texAlbedo) return;

    const W = gbuffer.target.width;
    const H = gbuffer.target.height;
    const pixels = Math.max(1, W * H);
    ensureOverlay(W, H);
    if (!overlayStore) return;

    const isBvhMode =
      debugMode === SCREEN_DEBUG_MODES.AlbedoBVH ||
      debugMode === SCREEN_DEBUG_MODES.AlbedoMatch;

    // upload camera uniforms
    U_PROJ_INV.value.copy(camera.projectionMatrixInverse);
    U_CAM_WORLD.value.copy(camera.matrixWorld);
    U_CAM_POS.value.copy(camera.position);

    if (isBvhMode) {
      const bvhNode = bvh.bvhNode;
      const bvhPositionNode = bvh.positionNode;
      const bvhIndexNode = bvh.indexNode;
      const bvhColorNode = bvh.colorNode;
      const diffuseArrayTex = bvh.diffuseArrayTex;

      if (
        !bvhNode ||
        !bvhPositionNode ||
        !bvhIndexNode ||
        !bvhColorNode ||
        !diffuseArrayTex
      )
        return;

      const needRebuildBvh =
        !debugComputeBvh ||
        pixels !== lastBvhPixels ||
        bvhNode !== lastBvhNode ||
        bvhPositionNode !== lastBvhPositionNode ||
        bvhIndexNode !== lastBvhIndexNode ||
        bvhColorNode !== lastBvhColorNode ||
        diffuseArrayTex !== lastDiffuseTex;

      if (needRebuildBvh) {
        lastBvhPixels = pixels;
        lastBvhNode = bvhNode;
        lastBvhPositionNode = bvhPositionNode;
        lastBvhIndexNode = bvhIndexNode;
        lastBvhColorNode = bvhColorNode;
        lastDiffuseTex = diffuseArrayTex;

        const diffuseTex = tslTexture(diffuseArrayTex);
        const diffuseTexSampler = sampler(diffuseArrayTex);

        const includeBvh = wgslFn(
          /* wgsl */ `
          fn include_bvh() -> i32 {
            return 0;
          }
        `,
          [bvhNode, bvhPositionNode, bvhIndexNode, bvhColorNode],
        );

        const MODE_ALBEDO_MATCH = int(SCREEN_DEBUG_MODES.AlbedoMatch);

        debugComputeBvh = Fn(() => {
          const includeBvhBindings = includeBvh();
          const tid = int(instanceIndex).add(includeBvhBindings);
          const x = tid.mod(int(W));
          const y = tid.div(int(W));
          const uvCoord = vec2(
            x.toFloat().add(0.5).div(W),
            y.toFloat().add(0.5).div(H),
          );

          const depth = tslTexture(texDepth, uvCoord).r;
          const validDepth = depth
            .greaterThan(float(1e-6))
            .and(depth.lessThan(float(1e6)));

          const viewPos = getViewPosition(uvCoord, depth, U_PROJ_INV);
          const worldPos = U_CAM_WORLD.mul(vec4(viewPos, 1.0)).xyz;

          const outC = vec4(0);

          If(validDepth, () => {
            const rayDir = normalize(worldPos.sub(U_CAM_POS));
            const hitAlbedo = bvhAlbedoAtRay(
              U_CAM_POS,
              rayDir,
              diffuseTex,
              diffuseTexSampler,
            );
            const hitFlag = hitAlbedo.w;

            If(hitFlag.greaterThan(float(0.0)), () => {
              const arrayAlbedo = hitAlbedo.xyz;
              const gbufferAlbedo = tslTexture(texAlbedo, uvCoord).xyz;
              const err = abs(arrayAlbedo.sub(gbufferAlbedo));
              const color = select(
                U_DEBUG_MODE.equal(MODE_ALBEDO_MATCH),
                err,
                arrayAlbedo,
              );
              outC.assign(vec4(color, 1.0));
            }).Else(() => {
              outC.assign(vec4(0.0, 0.0, 0.0, 1.0));
            });
          });

          const flatPix = y.mul(int(W)).add(x);
          overlayStore!.element(flatPix).assign(
            validDepth.select(outC, vec4(0)),
          );
        })()
          .compute(pixels)
          .setName('Surfel Screen Debug Overlay (BVH Albedo)');
      }

      renderer.compute(debugComputeBvh!);
      return;
    }

    // pool storage
    const surfelAttr = pool.getSurfelAttr();
    const momentsAttr = pool.getMomentsAttr();
    // Grid Params
    const offsetsAndListAttr = grid.getOffsetsAndListAttr();
    const guidingAttr = pool.getGuidingAttr();
    const touchedAtomic = pool.getTouched();
    const tileAllocAttr = find.getTileAllocAttr();

    if (
      !surfelAttr ||
      !momentsAttr ||
      !offsetsAndListAttr ||
      !guidingAttr ||
      !touchedAtomic ||
      !tileAllocAttr
    )
      return;

    const surfelDepthAttr = pool.getSurfelDepthAttr();
    if (!surfelDepthAttr) return;

    U_PREV_CAM_POS.value.copy(prevCameraPos);
    snap_to_surfel_grid_origin(U_GRID_ORIGIN.value, camera.position);
    U_FRAME.value = renderer.info.frame;
    U_GRID_STRIDE.value = Math.max(1, Math.ceil(W / 8));
    // Interested in fresh values from the double-buffered moments
    const { writeOffset } = pool.getOffsets();
    U_MOMENTS_OFFSET.value = writeOffset;

    const needRebuild =
      !debugCompute ||
      surfelAttr !== lastSurfelsAttr ||
      momentsAttr !== lastMomentsAttr ||
      offsetsAndListAttr !== lastOffsetsAndListAttr ||
      pixels !== lastPixels ||
      surfelDepthAttr !== lastSurfelDepthAttr;

    if (needRebuild) {
      lastSurfelsAttr = surfelAttr;
      lastMomentsAttr = momentsAttr;
      lastOffsetsAndListAttr = offsetsAndListAttr;
      lastPixels = pixels;
      lastSurfelDepthAttr = surfelDepthAttr;

      const capacity = surfelAttr.count;
      const surfels = storage(surfelAttr, SurfelStruct, capacity);
      const moments = storage(momentsAttr, SurfelMoments, capacity * 2);
      const offsetsAndList = storage(
        offsetsAndListAttr,
        'int',
        offsetsAndListAttr.count,
      );
      const guiding = storage(guidingAttr, 'float', guidingAttr.count);
      const tileAlloc = storage(tileAllocAttr, 'int', tileAllocAttr.count);
      const surfelDepth = storage(
        surfelDepthAttr,
        'vec4',
        surfelDepthAttr.count,
      )
        .setAccess('readOnly')
        .setName('surfelDepth');

      const includeSurfelDepth = wgslFn(
        /* wgsl */ `
        fn include_surfel_depth() -> i32 {
          return 0;
        }
      `,
        [surfelDepth],
      );

      const maxFetch = int(maxFetchPerPixel);

      const MODE_SURFELS = int(SCREEN_DEBUG_MODES.Surfels);
      const MODE_IRRADIANCE = int(SCREEN_DEBUG_MODES.Irradiance);
      const MODE_HEATMAP = int(SCREEN_DEBUG_MODES.Heatmap);
      const MODE_CASCADES = int(SCREEN_DEBUG_MODES.Cascades);
      const MODE_CELL_HASH = int(SCREEN_DEBUG_MODES.CellHash);
      const MODE_GRID = int(SCREEN_DEBUG_MODES.GridCoords);
      const MODE_WORLD_POS = int(SCREEN_DEBUG_MODES.WorldPos);
      const MODE_DEPTH = int(SCREEN_DEBUG_MODES.Depth);
      const MODE_NORMALS = int(SCREEN_DEBUG_MODES.Normals);
      const MODE_ALBEDO = int(SCREEN_DEBUG_MODES.Albedo);
      const MODE_VARIANCE = int(SCREEN_DEBUG_MODES.Variance);
      const MODE_COVERAGE = int(SCREEN_DEBUG_MODES.Coverage);
      const MODE_SLG = int(SCREEN_DEBUG_MODES.SLGGrid);
      const MODE_SPAWN_DESPAWN = int(SCREEN_DEBUG_MODES.SpawnDespawn);
      const MODE_RADIAL_OCC = int(SCREEN_DEBUG_MODES.RadialOcclusion);
      const MODE_RADIAL_TILE = int(SCREEN_DEBUG_MODES.RadialDepthTile);

      debugCompute = Fn(() => {
        const includeDepth = includeSurfelDepth({ surfelDepth });
        const tid = int(instanceIndex).add(includeDepth);
        const x = tid.mod(int(W));
        const y = tid.div(int(W));
        const uvCoord = vec2(
          x.toFloat().add(0.5).div(W),
          y.toFloat().add(0.5).div(H),
        );

        const depth = tslTexture(texDepth, uvCoord).r;
        const encN = tslTexture(texNormal, uvCoord).xyz;
        const pixelNormal = encN.mul(2.0).sub(1.0).normalize();
        const validDepth = depth
          .greaterThan(float(1e-6))
          .and(depth.lessThan(float(1e6)));

        const viewPos = getViewPosition(uvCoord, depth, U_PROJ_INV);

        const worldPos = U_CAM_WORLD.mul(vec4(viewPos, 1.0)).xyz;
        const pRel = worldPos.sub(U_GRID_ORIGIN); // relative to grid origin

        const gridCoord = surfel_pos_to_grid_coord(pRel);
        const c4 = surfel_grid_coord_to_c4(gridCoord);
        const rawHash = surfel_grid_c4_to_hash(c4);
        const cellIdx = rawHash.toInt();

        const start = offsetsAndList.element(cellIdx);
        const end = offsetsAndList.element(cellIdx.add(int(1)));
        const count = end.sub(start).max(int(0));
        const capped = min(maxFetch, count);

        let sumR = float(0),
          sumG = float(0),
          sumB = float(0),
          sumW = float(0);
        const outC = vec4(0);

        If(U_DEBUG_MODE.equal(MODE_SURFELS), () => {
          Loop(capped, ({ i }) => {
            const sid = offsetsAndList.element(
              int(OFFSETS_AND_LIST_START).add(start).add(i),
            );
            const validSid = sid
              .greaterThanEqual(int(0))
              .and(sid.lessThan(int(capacity)));

            If(validSid, () => {
              const s = surfels.element(sid);
              const posb = s.get('posb');
              const sPos = posb.xyz;
              const nRaw = s.get('normal');

              const sRad = surfel_radius_for_pos(sPos, U_CAM_POS).mul(
                SURFEL_RADIUS_OVERSCALE,
              );

              const pos_offset = worldPos.sub(sPos);
              const directional_weight = max(0, dot(nRaw, pixelNormal));

              const dist = length(pos_offset);
              const mahalanobis_dist = dist.mul(
                float(1)
                  .add(abs(dot(pos_offset, nRaw)))
                  .mul(SURFEL_NORMAL_DIRECTION_SQUISH),
              );

              const weight = smoothstep(sRad, 0.0, mahalanobis_dist).mul(
                directional_weight,
              );

              const f = sid.toFloat();
              const r = f
                .mul(float(12.9898))
                .sin()
                .fract()
                .mul(float(0.75))
                .add(float(0.25));
              const g = r
                .mul(float(1.3))
                .fract()
                .mul(float(0.75))
                .add(float(0.25));
              const b = r
                .mul(float(1.7))
                .fract()
                .mul(float(0.75))
                .add(float(0.25));

              sumR.addAssign(r.mul(weight));
              sumG.addAssign(g.mul(weight));
              sumB.addAssign(b.mul(weight));
              sumW.addAssign(weight);
            });
          });
          const alpha = sumW.clamp(float(0), float(1));
          const invW = sumW
            .greaterThan(float(0))
            .select(float(1).div(sumW), float(0));
          outC.assign(
            vec4(sumR.mul(invW), sumG.mul(invW), sumB.mul(invW), alpha),
          );
        });

        If(U_DEBUG_MODE.equal(MODE_IRRADIANCE), () => {
          const sumW = float(0).toVar();
          const sumLight = vec3(0, 0, 0).toVar();
          Loop(capped, ({ i }) => {
            const sid = offsetsAndList.element(
              int(OFFSETS_AND_LIST_START).add(start).add(i),
            );
            const validSid = sid
              .greaterThanEqual(int(0))
              .and(sid.lessThan(int(capacity)));

            If(validSid, () => {
              // @ts-ignore
              const irr = resolveIrradiance({
                sid,
                surfels,
                moments,
                pixNormal: pixelNormal,
                worldPos,
                U_FRAME,
                U_MOMENTS_OFFSET,
                U_CAM_POS,
                surfelDepth,
              });
              sumW.addAssign(irr.w); // Weight
              sumLight.addAssign(irr.xyz); // Color
            });
          });
          const alpha = sumW.clamp(float(0), float(1));
          const invW = sumW
            .greaterThan(float(0))
            .select(float(1).div(sumW), float(0));
          outC.assign(vec4(sumLight.mul(invW), alpha));
        });

        If(U_DEBUG_MODE.equal(MODE_VARIANCE), () => {
          const sumW = float(0).toVar();
          const sumVar = float(0).toVar();
          Loop(capped, ({ i }) => {
            const sid = offsetsAndList.element(
              int(OFFSETS_AND_LIST_START).add(start).add(i),
            );
            const validSid = sid
              .greaterThanEqual(int(0))
              .and(sid.lessThan(int(capacity)));

            If(validSid, () => {
              const s = surfels.element(sid);
              const sPos = s.get('posb').xyz;
              const sNor = s.get('normal');

              const sRad = surfel_radius_for_pos(sPos, U_CAM_POS).mul(
                SURFEL_RADIUS_OVERSCALE,
              );
              const posOffset = worldPos.sub(sPos);
              const dist = length(posOffset);
              const alignPenalty = abs(dot(posOffset, sNor)).mul(
                SURFEL_NORMAL_DIRECTION_SQUISH,
              );
              const mahal = dist.mul(float(1.0).add(alignPenalty));
              const dotN = max(float(0.0), dot(sNor, pixelNormal));

              const weight = smoothstep(sRad, 0.0, mahal).mul(dotN);
              const momentsIndex = sid.add(U_MOMENTS_OFFSET);
              const varianceVec = moments
                .element(momentsIndex)
                .get('msmeData1').xyz;
              const variance = dot(varianceVec, vec3(0.2126, 0.7152, 0.0722));

              sumVar.addAssign(variance.mul(weight));
              sumW.addAssign(weight);
            });
          });

          const invW = sumW
            .greaterThan(float(0))
            .select(float(1.0).div(sumW), float(0.0));
          const v = sumVar.mul(invW).mul(U_VARIANCE_SCALE).clamp(0.0, 1.0);

          const r = float(1.5)
            .sub(abs(v.mul(4.0).sub(3.0)))
            .clamp(0.0, 1.0);
          const g = float(1.5)
            .sub(abs(v.mul(4.0).sub(2.0)))
            .clamp(0.0, 1.0);
          const b = float(1.5)
            .sub(abs(v.mul(4.0).sub(1.0)))
            .clamp(0.0, 1.0);
          const alpha = sumW.clamp(float(0), float(1));

          outC.assign(vec4(r, g, b, alpha));
        });

        If(U_DEBUG_MODE.equal(MODE_HEATMAP), () => {
          const heat = float(count).div(float(64.0));

          outC.assign(
            count
              .greaterThan(0)
              .select(
                vec4(heat, float(1).sub(heat), 0.0, 1.0),
                vec4(0, 0, 1.0, 1.0),
              ),
          );
        });

        If(U_DEBUG_MODE.equal(MODE_CASCADES), () => {
          const cascade = float(c4.w).add(1);
          const r = fract(cascade.mul(0.456));
          const g = fract(cascade.mul(0.789));
          const b = fract(cascade.mul(0.123));
          outC.assign(vec4(r, g, b, 1.0));
        });

        If(U_DEBUG_MODE.equal(MODE_CELL_HASH), () => {
          const r = float(cellIdx).mul(0.123).fract();
          const g = float(cellIdx).mul(0.456).fract();
          const b = float(cellIdx).mul(0.789).fract();
          outC.assign(vec4(r, g, b, 1.0));
        });

        If(U_DEBUG_MODE.equal(MODE_GRID), () => {
          const cx = float(gridCoord.x).mul(0.1).fract();
          const cy = float(gridCoord.y).mul(0.1).fract();
          const cz = float(gridCoord.z).mul(0.1).fract();
          outC.assign(vec4(cx, cy, cz, 1.0));
        });

        If(U_DEBUG_MODE.equal(MODE_WORLD_POS), () => {
          outC.assign(vec4(worldPos.x, worldPos.y, worldPos.z, 1.0));
        });

        If(U_DEBUG_MODE.equal(MODE_DEPTH), () => {
          const depthSample = depth.clamp(0.0, 1.0);
          outC.assign(vec4(depthSample, depthSample, depthSample, 1.0));
        });

        If(U_DEBUG_MODE.equal(MODE_NORMALS), () => {
          const nColor = pixelNormal.mul(0.5).add(0.5);
          outC.assign(vec4(nColor.x, nColor.y, nColor.z, 1.0));
        });

        If(U_DEBUG_MODE.equal(MODE_SPAWN_DESPAWN), () => {
          const gridWNode = int(U_GRID_STRIDE); // From Uniforms!
          const gx = x.div(8);
          const gy = y.div(8);
          const tIdx = gy.mul(gridWNode).add(gx);

          // Read flag (stride is 2 ints: [flag, bestParentId])
          const flag = tileAlloc.element(tIdx.mul(2));
          // To debug if an appropriate 'father' surfel was found
          const bestParentSelected = tileAlloc
            .element(tIdx.mul(2).add(1))
            .greaterThan(0);

          outC.assign(
            vec4(
              float(flag),
              float(flag).negate(),
              bestParentSelected.select(1, 0),
              1.0,
            ),
          );
        });

        If(U_DEBUG_MODE.equal(MODE_ALBEDO), () => {
          const albedo = tslTexture(texAlbedo, uvCoord).xyz;
          outC.assign(vec4(albedo, 1.0));
        });

        If(U_DEBUG_MODE.equal(MODE_COVERAGE), () => {
          const aliveCount = int(0).toVar();

          Loop(capped, ({ i }) => {
            const sid = offsetsAndList.element(
              int(OFFSETS_AND_LIST_START).add(start).add(i),
            );
            const validSid = sid
              .greaterThanEqual(int(0))
              .and(sid.lessThan(int(capacity)));

            If(validSid, () => {
              const age = surfels.element(sid).get('age');
              If(age.lessThan(int(SURFEL_LIFE_RECYCLE)), () => {
                aliveCount.addAssign(int(1));
              });
            });
          });

          const deadCount = count.sub(aliveCount).max(int(0));
          const SCALE = float(64.0);
          const aliveN = float(aliveCount).div(SCALE);
          const deadN = float(deadCount).div(SCALE);

          outC.assign(
            count
              .greaterThan(int(0))
              .select(vec4(deadN, aliveN, 0.0, 1.0), vec4(0.0, 0.0, 1.0, 1.0)),
          );
        });

        // [SLG] New mode: visualize the 8×8 SLG grid of a surfel in this cell
        // [SLG] New mode: visualize one 8×8 SLG grid per 8×8 *screen tile*.
        // Each tile shows the SLG of the first surfel in the hash cell at the tile's center.
        If(U_DEBUG_MODE.equal(MODE_SLG), () => {
          const TILE = int(8);
          const tileX = x.div(TILE);
          const tileY = y.div(TILE);
          const localX = x.mod(TILE);
          const localY = y.mod(TILE);

          const centerX = tileX.mul(TILE).add(TILE.div(2));
          const centerY = tileY.mul(TILE).add(TILE.div(2));
          const centerUv = vec2(
            centerX.toFloat().add(0.5).div(W),
            centerY.toFloat().add(0.5).div(H),
          );
          const depthC = tslTexture(texDepth, centerUv).r;

          If(depthC.greaterThan(1e-6).and(depthC.lessThan(1e6)), () => {
            const viewPosC = getViewPosition(centerUv, depthC, U_PROJ_INV);
            const worldPosC = U_CAM_WORLD.mul(vec4(viewPosC, 1.0)).xyz;
            const pRelC = worldPosC.sub(U_GRID_ORIGIN);
            const gridCoordC = surfel_pos_to_grid_coord(pRelC);
            const c4C = surfel_grid_coord_to_c4(gridCoordC);
            const cellIdxC = surfel_grid_c4_to_hash(c4C).toInt();

            const startC = offsetsAndList.element(cellIdxC);
            const endC = offsetsAndList.element(cellIdxC.add(1));
            const countC = endC.sub(startC).max(0);

            // Iterate neighbors to find BEST surfel (matching surface)
            const bestSid = int(-1).toVar();
            const maxWeight = float(-1.0).toVar();

            Loop(min(countC, 64), ({ i }) => {
              const sid = offsetsAndList.element(
                int(OFFSETS_AND_LIST_START).add(startC).add(i),
              );
              const s = surfels.element(sid);
              const sPos = s.get('posb').xyz;
              const sNor = s.get('normal');
              const posOffset = worldPosC.sub(sPos);
              const dist = length(posOffset);
              const dotN = max(0.0, dot(sNor, pixelNormal));
              const sRad = surfel_radius_for_pos(sPos, U_CAM_POS);
              const weight = dotN.mul(oneMinus(dist.div(sRad)).max(0));

              If(weight.greaterThan(maxWeight), () => {
                maxWeight.assign(weight);
                bestSid.assign(sid);
              });
            });

            If(bestSid.greaterThanEqual(0), () => {
              const s = surfels.element(bestSid);
              // Visualize 8x8 Grid
              const gx = localX.clamp(0, 7);
              const gy = localY.clamp(0, 7);
              const base = bestSid.mul(int(SLG_TOTAL_FLOATS));
              const cellIndex = gy.mul(8).add(gx);
              const w = guiding.element(base.add(cellIndex));

              const rowSumBase = base.add(int(SLG_LOBE_COUNT));
              let total = float(0).toVar();
              Loop(8, ({ i }) =>
                total.addAssign(guiding.element(rowSumBase.add(i))),
              );
              const avg = total.div(64.0);

              const intensity = w.div(avg.add(0.0001)).mul(0.25);

              let momentsIndex = bestSid.add(U_MOMENTS_OFFSET);
              let m = moments.element(momentsIndex);

              outC.assign(vec4(m.get('guiding').xyz, m.get('guiding').w));

              const age = U_FRAME.sub(s.get('posb').w);
              // Borders: Green = Alive, Red = Just Spawned (Age 0)
              If(localX.equal(0).or(localY.equal(0)), () => {
                outC.assign(
                  age
                    .greaterThan(10)
                    .select(vec4(0, 1, 0, 0.2), vec4(1, 0, 0, 0.2)),
                );
              });
            }).Else(() => {
              outC.assign(vec4(0.1, 0, 0, 0.5)); // No valid surfel found
            });
          });
        });

        If(U_DEBUG_MODE.equal(MODE_RADIAL_OCC), () => {
          const bestSid = int(-1).toVar();
          const bestW = float(0.0).toVar();
          const sRad = float(0.0).toVar();

          // Pick a dominant surfel similarly to resolve (geometry+normal weight)
          Loop(capped, ({ i }) => {
            const sid = offsetsAndList.element(
              int(OFFSETS_AND_LIST_START).add(start).add(i),
            );
            const validSid = sid
              .greaterThanEqual(int(0))
              .and(sid.lessThan(int(capacity)));

            If(validSid, () => {
              const s = surfels.element(sid);
              const sPos = s.get('posb').xyz;
              const sNor = s.get('normal');

              sRad.assign(
                surfel_radius_for_pos(sPos, U_CAM_POS).mul(
                  SURFEL_RADIUS_OVERSCALE,
                ),
              );

              const dV = worldPos.sub(sPos);
              const distLen = dV.length();
              const wDir = max(float(0.0), dot(sNor, pixelNormal));
              const dotN = abs(dot(dV, sNor));
              const mDist = distLen.mul(
                float(1.0).add(dotN.mul(SURFEL_NORMAL_DIRECTION_SQUISH)),
              );

              const wGeom = smoothstep(sRad, float(0.0), mDist);
              const w = wGeom.mul(wDir);

              If(w.greaterThan(bestW), () => {
                bestW.assign(w);
                bestSid.assign(sid);
              });
            });
          });

          // Compute radial occlusion for the best surfel -> this pixel
          If(
            bestSid
              .greaterThanEqual(int(0))
              .and(bestW.greaterThan(float(1e-6))),
            () => {
              const s = surfels.element(bestSid);
              const sPos = s.get('posb').xyz;
              const sNor = s.get('normal');

              const dV = worldPos.sub(sPos);
              const distLen = dV.length();
              const dirWS = dV.div(max(float(1e-6), distLen));

              const n = normalize(sNor);
              let up = select(
                abs(n.z).lessThan(0.999),
                vec3(0, 0, 1),
                vec3(1, 0, 0),
              );
              let t = normalize(cross(up, n));
              let b = cross(n, t);
              const hemi = vec3(dot(dirWS, t), dot(dirWS, b), dot(dirWS, n));

              let uv = hemiOctSquareEncode(normalize(hemi));

              let m = point_sample_radial_depth(uint(bestSid), uv);

              const occ = surfelRadialDepthOcclusion({
                surfelIndex: uint(bestSid),
                dirWS: dirWS,
                normalWS: sNor,
                dist: distLen,
                pixelNormal: pixelNormal,
                dV: dV,
                sRad: sRad,
                params: U_OCCLUSION_PARAMS,
              });

              // Visualize "blocked amount" (1-occ) as red overlay
              const blocked = oneMinus(occ).clamp(0.0, 1.0);
              outC.assign(
                vec4(blocked, distLen.div(max(0.001, m.x)).sub(vec3(blocked))),
              );
            },
          ).Else(() => {
            outC.assign(vec4(0.0, 0.0, 0.0, 0.0));
          });
        });

        If(U_DEBUG_MODE.equal(MODE_RADIAL_TILE), () => {
          const TILE = int(8);

          const tileX = x.div(TILE);
          const tileY = y.div(TILE);
          const localX = x.mod(TILE);
          const localY = y.mod(TILE);

          // Pick surfel from the cell at the TILE CENTER (like SLG mode)
          const centerX = tileX.mul(TILE).add(TILE.div(2));
          const centerY = tileY.mul(TILE).add(TILE.div(2));
          const centerUv = vec2(
            centerX.toFloat().add(0.5).div(W),
            centerY.toFloat().add(0.5).div(H),
          );

          const depthC = tslTexture(texDepth, centerUv).r;

          If(depthC.greaterThan(1e-6).and(depthC.lessThan(1e6)), () => {
            const encNC = tslTexture(texNormal, centerUv).xyz;
            const nC = encNC.mul(2.0).sub(1.0).normalize();

            const viewPosC = getViewPosition(centerUv, depthC, U_PROJ_INV);
            const worldPosC = U_CAM_WORLD.mul(vec4(viewPosC, 1.0)).xyz;

            const pRelC = worldPosC.sub(U_GRID_ORIGIN);
            const gridCoordC = surfel_pos_to_grid_coord(pRelC);
            const c4C = surfel_grid_coord_to_c4(gridCoordC);
            const cellIdxC = surfel_grid_c4_to_hash(c4C).toInt();

            const startC = offsetsAndList.element(cellIdxC);
            const endC = offsetsAndList.element(cellIdxC.add(int(1)));
            const countC = endC.sub(startC).max(int(0));

            const bestSid = int(-1).toVar();
            const bestW = float(-1.0).toVar();

            Loop(min(countC, 64), ({ i }) => {
              const sid = offsetsAndList.element(
                int(OFFSETS_AND_LIST_START).add(startC).add(i),
              );
              const validSid = sid
                .greaterThanEqual(0)
                .and(sid.lessThan(int(capacity)));

              If(validSid, () => {
                const sPos = surfels.element(sid).get('posb').xyz;
                const sNor = surfels.element(sid).get('normal');

                const dist = length(worldPosC.sub(sPos));
                const sRad = surfel_radius_for_pos(sPos, U_CAM_POS).mul(
                  SURFEL_RADIUS_OVERSCALE,
                );
                const w = max(0.0, dot(sNor, nC)).mul(
                  oneMinus(dist.div(sRad)).max(0.0),
                );

                If(w.greaterThan(bestW), () => {
                  bestW.assign(w);
                  bestSid.assign(sid);
                });
              });
            });

            If(bestSid.greaterThanEqual(0), () => {
              // Map 8×8 pixels -> 4×4 texels (2×2 per texel)
              const tx = localX.div(2);
              const ty = localY.div(2);

              const uvRD = vec2(
                tx.toFloat().add(0.5).div(float(SURFEL_DEPTH_TEXELS)),
                ty.toFloat().add(0.5).div(float(SURFEL_DEPTH_TEXELS)),
              );

              const m = point_sample_radial_depth(uint(bestSid), uvRD);

              const mean = m.x;

              // Normalize mean by this surfel's current maxDepth (= 2*sRad)
              const sPos = surfels.element(bestSid).get('posb').xyz;
              const sRad = surfel_radius_for_pos(sPos, U_CAM_POS).mul(
                SURFEL_RADIUS_OVERSCALE,
              );
              const maxDepth = sRad.mul(2.0);

              const meanN = mean
                .div(max(float(1e-6), maxDepth))
                .clamp(0.0, 1.0);

              // grayscale tile
              outC.assign(vec4(meanN, meanN, m.w.div(255.0), 0.75));
            });
          });
        });

        const doWrite = validDepth.or(U_DEBUG_MODE.equal(MODE_SLG));

        const flatPix = y.mul(int(W)).add(x);
        overlayStore!.element(flatPix).assign(doWrite.select(outC, vec4(0)));
      })()
        .compute(pixels)
        .setName('Surfel Screen Debug Overlay');
    }
    renderer.compute(debugCompute!);
  }

  // ---------- public ----------
  function renderOverlay(renderer: THREE.WebGPURenderer) {
    if (!show || !quad || !blitMat) return;
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    quad.render(renderer);
    renderer.autoClear = prevAutoClear;
  }

  return {
    run,
    renderOverlay,
    setShow,
    setMaxFetch,
    setDebugMode,
    configureGUI,
    debugParams,
  };
}
