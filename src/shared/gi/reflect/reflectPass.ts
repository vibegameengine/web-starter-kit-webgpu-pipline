// @ts-nocheck -- TSL/WGSL node graphs; the published types describe none of this well.
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  clamp,
  float,
  getViewPosition,
  instanceIndex,
  int,
  ivec2,
  max,
  metalness,
  mrt,
  roughness,
  sampler,
  storage,
  texture,
  textureStore,
  uniform,
  vec2,
  vec3,
  vec4,
  wgslFn,
} from 'three/tsl';
import {
  bvhIntersectFirstHit,
  constants as bvhConstants,
  getVertexAttribute,
  intersectionResultStruct,
  rayStruct,
} from '../bvh/webgpu/index.js';
import {
  dynBoundsHit,
  dynBvhIntersectFirstHit,
  getDynVertexAttribute,
  sceneHitStruct,
  traceScene,
  traceSceneOccluded,
} from '../surfel/dynamicBvh.ts';
import { SurfelMoments, SurfelStruct, type SurfelPool } from '../surfel/surfelPool.ts';
import {
  snap_to_surfel_grid_origin,
  type SurfelHashGrid,
} from '../surfel/surfelHashGrid.ts';
import { U_OCCLUSION_PARAMS } from '../surfel/surfelRadialDepth.ts';
import { consts } from '../surfel/wgslConsts.ts';
import { giKnobs } from '../surfel/knobs.ts';
import {
  probeGridHelpers,
  probeJitter,
  probeRadiusEpsilon,
  probeSampleEnv,
  probeSurfelCacheRO,
  probeTangentBasis,
} from '../probe/probeWgsl.ts';
import { probeScene, probeSettings } from '../probe/settings.ts';
import {
  reflectDiffuseLod,
  reflectG2overG1,
  reflectSampleDiffuse,
  reflectSampleVndf,
  reflectShadeHit,
} from './reflectWgsl.ts';
import { reflectSettings, reflectStats, reflectTextures } from './settings.ts';
import { injectReflectTestScene } from './testScene.ts';

/**
 * Screen-space specular gather — Lumen's reflection pass, on this build's parts.
 *
 * The frame composited `direct + gi x albedo` and nothing else, which is a purely
 * diffuse renderer: every glossy surface in it was as flat as a wall. Lumen's answer is
 * not a term added to the diffuse gather, it is a separate pass over the *same* scene
 * representation — importance-sampled by the BRDF instead of the cosine, resolved and
 * denoised on its own, with the surface cache supplying hit radiance. That shape is what
 * this is.
 *
 * Three dispatches, at half resolution:
 *
 *   prepare  full-res G-Buffer -> half-res (world position, normal, roughness,
 *            albedo, metalness). Also the only place the two G-Buffers this frame owns
 *            are reconciled: geometry comes from the surfel pass's, material properties
 *            from the frame graph's scene pass.
 *   trace    one VNDF-sampled ray per half-res pixel against both acceleration
 *            structures, shaded through `reflectShadeHit`, env on a miss.
 *   resolve  spatial bilateral across the lobe plus temporal reprojection, which is the
 *            same pair of ideas the probe tier already denoises with rather than a
 *            second denoiser with its own opinions.
 *
 * Half resolution because a BVH ray per screen pixel costs more than the entire probe
 * tier — the probes trace ~380k rays a frame after their stride, and full-res
 * reflections would be 1.0M. The roughness cut-off means a scene with no glossy material
 * dispatches three kernels that return on their first branch, which is what keeps this
 * free on the default Cornell box.
 */
export function createReflectPass(grid: SurfelHashGrid, pool: SurfelPool) {
  const U_PROJ_INV = uniform(new THREE.Matrix4());
  const U_CAM_WORLD = uniform(new THREE.Matrix4());
  const U_PREV_VIEW_PROJ = uniform(new THREE.Matrix4());
  const U_CAM_POS = uniform(new THREE.Vector3());
  const U_GRID_ORIGIN = uniform(new THREE.Vector3());
  const U_FRAME = uniform(0);
  const U_MOMENTS_READ = uniform(0);
  const U_LIGHT_DIR = uniform(new THREE.Vector3(0, 1, 0));
  const U_LIGHT_COLOR = uniform(new THREE.Color(1, 1, 1));
  const U_ENV_INTENSITY = uniform(1);
  const U_ENV_LOD = uniform(4);
  const U_ROUGH_CUT = uniform(0.4);
  const U_RANGE = uniform(8);
  const U_LOD_SCALE = uniform(1);
  const U_ALBEDO_BOOST = uniform(1);
  const U_DYN_TRACE = uniform(0);
  const U_TEMPORAL = uniform(0.1);
  const U_FILTER = uniform(1);
  const U_HISTORY_VALID = uniform(0);
  const U_HIST_CUR = uniform(0);
  const U_HIST_PREV = uniform(0);
  const U_DEBUG = uniform(0);
  const U_KILL_KD = uniform(1);
  const U_REPROJ_FLIP = uniform(1);

  let width = 0;
  let height = 0;
  let halfW = 0;
  let halfH = 0;
  let divisor = 0;

  let gA: THREE.Texture | null = null;
  let gB: THREE.Texture | null = null;
  let gC: THREE.Texture | null = null;
  let traceTex: THREE.Texture | null = null;
  let denoisedTex: THREE.Texture | null = null;
  let outTex: THREE.Texture | null = null;
  let historyAttr: THREE.StorageBufferAttribute | null = null;
  /**
   * Material properties, rasterised by this pass rather than read out of a G-Buffer.
   *
   * Both existing G-Buffers are full. The frame graph's scene pass already writes four
   * RGBA16F attachments, which is exactly the 32-byte-per-sample cap — adding a fifth
   * invalidated the command buffer outright, which is how this came to be its own
   * target. The surfel pass's has two attachments and is vendored.
   *
   * Half resolution and RGBA8, because the payload is two numbers in [0,1] consumed at
   * half res anyway, and because the whole raster is skipped on a scene with nothing
   * glossy in it — which is every scene this build shipped with.
   */
  let matTarget: THREE.RenderTarget | null = null;
  let matMRT: THREE.MRTNode | null = null;

  let prepareNode: THREE.ComputeNode | null = null;
  let traceNode: THREE.ComputeNode | null = null;
  let denoiseNode: THREE.ComputeNode | null = null;
  let upsampleNode: THREE.ComputeNode | null = null;

  let parity = 0;
  let hadHistory = false;
  let boundKey = '';

  function discard() {
    prepareNode = null;
    traceNode = null;
    denoiseNode = null;
    upsampleNode = null;
  }

  function makeTexture(w: number, h: number, type: number) {
    const tex = new THREE.StorageTexture(w, h);
    tex.type = type;
    tex.format = THREE.RGBAFormat;
    // The composite reads `outTex` at full screen UV, so the upsample is this filter.
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    return tex;
  }

  function resize(w: number, h: number) {
    const div = Math.max(1, Math.round(reflectSettings.resolutionDivisor));
    if (w === width && h === height && div === divisor && gA) return;
    width = w;
    height = h;
    divisor = div;
    halfW = Math.max(1, Math.ceil(w / div));
    halfH = Math.max(1, Math.ceil(h / div));

    reflectStats.width = halfW;
    reflectStats.height = halfH;

    // Float, not half: this holds a world-space ray origin. Half float resolves about a
    // centimetre across a Cornell box, and a centimetre of error in a mirror's ray
    // origin is a visibly wrong reflection at grazing angles. Nothing samples it — both
    // readers use textureLoad — so the format needing the float32-filterable feature
    // does not arise.
    gA = makeTexture(halfW, halfH, THREE.FloatType);
    gB = makeTexture(halfW, halfH, THREE.HalfFloatType);
    gC = makeTexture(halfW, halfH, THREE.HalfFloatType);
    traceTex = makeTexture(halfW, halfH, THREE.HalfFloatType);
    denoisedTex = makeTexture(halfW, halfH, THREE.HalfFloatType);
    // Full resolution, alone among these. The composite reads it at screen UV, and a
    // plain bilinear stretch of a half-res buffer put a bright ring right round the
    // chrome sphere: at the silhouette a bilinear tap mixes the metal's texels with the
    // wall's, which both bleeds the reflection outward and lets a fraction of the
    // suppressed diffuse term back in. The upsample has to know where the edges are, so
    // it is a pass rather than a filter mode.
    outTex = makeTexture(width, height, THREE.HalfFloatType);

    matTarget?.dispose();
    // Full res too, and for the same reason: `1 - metalness` is the factor the whole
    // frame's diffuse term is multiplied by, and half-resolution metalness is a
    // two-pixel error around every metal silhouette in the frame.
    matTarget = new THREE.RenderTarget(width, height, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
    });
    // The MRT node keys attachments by texture *name*, not by position: an unnamed
    // target and a key of `output` produce a fragment output struct with no members,
    // which fails WGSL parsing rather than falling back to anything.
    matTarget.texture.name = 'output';
    matTarget.texture.minFilter = THREE.NearestFilter;
    matTarget.texture.magFilter = THREE.NearestFilter;
    matTarget.texture.generateMipmaps = false;
    // `b = 1` is a written-here marker. The target is cleared each frame and a cleared
    // texel decodes as roughness 0, which is a mirror — the most expensive possible way
    // to be wrong about a pixel of sky.
    matMRT = mrt({ output: vec4(metalness, roughness, 1, 1) });

    // Two generations, two fields each: the blended radiance and the world position it
    // was blended at. Position rather than depth because the validation this needs is
    // "is last frame's sample the same surface", and comparing world positions answers
    // that without a second depth history to keep in step.
    historyAttr = new THREE.StorageBufferAttribute(
      new Float32Array(halfW * halfH * 2 * 2 * 4),
      4,
    );

    // Deliberately NOT published here. A scene with nothing glossy in it never runs the
    // chain, and the composite multiplies the diffuse term by this texture's alpha —
    // publishing an unwritten target would put a zero over every pixel of GI in the
    // frame. It is published at the end of the first successful run instead, which also
    // means the default scene's composite is byte-identical to what it was.
    reflectTextures.reflection = null;
    parity = 0;
    hadHistory = false;
    discard();
  }

  function key(gbuffer: { target: THREE.RenderTarget }) {
    return `${gbuffer.target.id}:${gbuffer.target.width}x${gbuffer.target.height}:${divisor}`;
  }

  /**
   * Is there anything in this scene a specular ray would be spent on?
   *
   * The whole tier is free on a scene of roughness-1 walls only if the *raster* is
   * skipped too — three compute kernels that return on their first branch cost nothing,
   * a full scene draw costs a full scene draw. Rescanned occasionally rather than every
   * frame because a material's roughness is not a per-frame quantity, and the one thing
   * that does change the answer here — the test scene injecting itself — happens once.
   */
  let glossScanFrame = -1;
  let hasGloss = false;
  function sceneHasGloss(scene: THREE.Object3D | null, frame: number): boolean {
    if (!scene) return false;
    if (glossScanFrame >= 0 && frame - glossScanFrame < 60) return hasGloss;
    glossScanFrame = frame;
    hasGloss = false;
    const cut = reflectSettings.roughnessCutoff;
    scene.traverse((object) => {
      if (hasGloss) return;
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const r = (material as THREE.MeshStandardMaterial | undefined)?.roughness;
        if (typeof r === 'number' && r <= cut) {
          hasGloss = true;
          return;
        }
      }
    });
    return hasGloss;
  }

  /** One extra scene draw, at half resolution, into a two-channel target. */
  function renderMaterialGBuffer(
    renderer: THREE.WebGPURenderer,
    camera: THREE.PerspectiveCamera,
  ) {
    const scene = probeScene.scene;
    if (!scene || !matTarget || !matMRT) return;
    const previousTarget = renderer.getRenderTarget();
    const previousBackground = scene.background;
    // The background is an equirect environment map with no metalness or roughness to
    // report; drawing it would only write the marker bit over the sky.
    scene.background = null;
    renderer.setMRT(matMRT);
    renderer.setRenderTarget(matTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previousTarget);
    renderer.setMRT(null);
    scene.background = previousBackground;
  }

  function build(gbuffer: { target: THREE.RenderTarget }) {
    const bvh = probeScene.bvh;
    const dynBvh = probeScene.dynBvh;
    const env = probeScene.env;
    const metalRough = matTarget?.texture;
    if (!bvh || !dynBvh || !env || !metalRough) return false;

    const texDepth = gbuffer.target.depthTexture;
    const texNormal = gbuffer.target.textures[0];
    const texAlbedo = gbuffer.target.textures[1];
    const surfelAttr = pool.getSurfelAttr();
    const momentsAttr = pool.getMomentsAttr();
    const offsetsAndListAttr = grid.getOffsetsAndListAttr();
    const surfelDepthAttr = pool.getSurfelDepthAttr();
    if (
      !texDepth ||
      !texNormal ||
      !texAlbedo ||
      !surfelAttr ||
      !momentsAttr ||
      !offsetsAndListAttr ||
      !surfelDepthAttr
    ) {
      return false;
    }

    const capacity = surfelAttr.count;
    const surfelsRO = storage(surfelAttr, SurfelStruct, capacity)
      .setAccess('readOnly')
      .setName('surfels');
    const momentsRO = storage(momentsAttr, SurfelMoments, capacity * 2)
      .setAccess('readOnly')
      .setName('moments');
    const offsetsAndListRO = storage(offsetsAndListAttr, 'int', offsetsAndListAttr.count)
      .setAccess('readOnly')
      .setName('offsetsAndList');
    const surfelDepthRO = storage(surfelDepthAttr, 'vec4', surfelDepthAttr.count)
      .setAccess('readOnly')
      .setName('surfelDepth');

    // One node, read *and* written, rather than a read-only alias beside a read-write
    // one. Two storage nodes over one attribute produce two bindings of the same buffer
    // with conflicting usage in a single dispatch, which WebGPU rejects and which took
    // the whole command buffer down with it. There is no hazard to protect against: the
    // read is from the previous parity's half and the write is to the current one.
    const history = storage(historyAttr!, 'vec4', historyAttr!.count);

    /** Full-res UV of a half-res pixel's centre. */
    const fullUv = (hx, hy) =>
      vec2(
        hx.toFloat().add(0.5).div(float(halfW)),
        hy.toFloat().add(0.5).div(float(halfH)),
      );

    // ------------------------------------------------------------ 1. prepare
    prepareNode = Fn(() => {
      const tid = int(instanceIndex);
      const hx = tid.mod(int(halfW));
      const hy = tid.div(int(halfW));
      const uv = fullUv(hx, hy);

      const depth = texture(texDepth, uv).r;
      const valid = depth.lessThan(0.999).and(depth.greaterThan(0.0));

      const A = vec4(0).toVar();
      const B = vec4(0).toVar();
      const C = vec4(0).toVar();

      If(valid, () => {
        const viewPos = getViewPosition(uv, depth, U_PROJ_INV);
        const P = U_CAM_WORLD.mul(vec4(viewPos, 1.0)).xyz;
        const N = texture(texNormal, uv).xyz.mul(2.0).sub(1.0).normalize();
        const alb = texture(texAlbedo, uv).xyz;
        // b marks "the raster wrote this texel". The scene pass clears its extra MRT
        // attachments, and a cleared texel decodes as roughness 0, which is a mirror —
        // the single most expensive way to be wrong here.
        const mr = texture(metalRough, uv);
        const wrote = mr.b.greaterThan(float(0.5));
        A.assign(vec4(P, wrote.select(float(1), float(0))));
        B.assign(vec4(N, mr.g));
        C.assign(vec4(alb, mr.r));
      });

      textureStore(gA!, ivec2(hx, hy), A);
      textureStore(gB!, ivec2(hx, hy), B);
      textureStore(gC!, ivec2(hx, hy), C);
    })()
      .compute(halfW * halfH)
      .setName('Reflect prepare');

    // -------------------------------------------------------------- 2. trace
    const tracer = wgslFn(
      /* wgsl */ `
      fn reflectTraceTexel(
        hx: i32,
        hy: i32,
        gPos: texture_2d<f32>,
        gNor: texture_2d<f32>,
        gMat: texture_2d<f32>,
        diffuseTex: texture_2d_array<f32>,
        diffuseTexSampler: sampler,
        envTexture: texture_2d<f32>,
        envSampler: sampler,
        envIntensity: f32,
        envLod: f32,
        frame: u32,
        camPos: vec3f,
        lightDir: vec3f,
        lightColor: vec3f,
        gridOrigin: vec3f,
        momentsRead: u32,
        occParams: vec4f,
        roughCut: f32,
        range: f32,
        lodScale: f32,
        albedoBoost: f32,
        dynTrace: f32,
        dynBounds: vec4f,
        dbg: f32
      ) -> vec4f {
        let px = vec2i(hx, hy);
        let A = textureLoad(gPos, px, 0);
        if (A.w < 0.5) { return vec4f(0.0); }

        let B = textureLoad(gNor, px, 0);
        let rough = clamp(B.w, 0.015, 1.0);
        // Everything rougher belongs to the diffuse tier, which is already integrating
        // that hemisphere with 64 directions and a temporal history. One ray would be
        // strictly worse information at strictly higher cost.
        if (rough > roughCut) { return vec4f(0.0); }

        let C = textureLoad(gMat, px, 0);
        let P = A.xyz;
        let N = normalize(B.xyz);
        let V = normalize(camPos - P);
        if (dot(N, V) <= 1e-4) { return vec4f(0.0); }

        let metal = clamp(C.w, 0.0, 1.0);
        let F0 = mix(vec3f(0.04), C.xyz, metal);

        let basis = probeTangentBasis(N);
        let Ve = normalize(transpose(basis) * V);
        let alpha = rough * rough;

        let jit = probeJitter(u32(hy) * 65536u + u32(hx), 0u, frame);
        let H = reflectSampleVndf(Ve, alpha, jit.x, jit.y);
        let Ll = reflect(-Ve, H);
        // Below the horizon. VNDF sampling makes this rare rather than impossible.
        if (Ll.z <= 1e-4) { return vec4f(0.0); }

        let VoH = max(1e-4, dot(Ve, H));
        let F = F0 + (vec3f(1.0) - F0) * pow(1.0 - VoH, 5.0);
        let vis = reflectG2overG1(max(1e-4, Ve.z), Ll.z, alpha);
        let weight = F * vis;

        let L = normalize(basis * Ll);
        let sRad = probe_surfel_radius_for_pos(P - camPos);
        let eps = probeRadiusEpsilon(sRad);

        var ray: Ray;
        ray.origin = P + N * eps;
        ray.direction = L;
        // Both structures. A reflection that traced the static BVH alone would show a
        // room with the movers deleted from it, which is a more obvious lie in a mirror
        // than it ever was in a diffuse bounce.
        let hit = traceScene(ray, dynTrace, dynBounds);

        var Li = vec3f(0.0);
        if (!hit.didHit) {
          // Roughness-widened env lookup: a mirror wants the sharp map, and a lobe that
          // is about to be temporally averaged anyway wants a prefiltered one. The
          // diffuse tier's fixed lod 4 would put a blurred sky in a mirror.
          let lod = clamp(rough * 8.0, 0.0, envLod);
          Li = probeSampleEnv(L, envTexture, envSampler, lod) * envIntensity;
        } else {
          let hitPoint = ray.origin + ray.direction * hit.dist;
          let hitNormal = normalize(hit.normal);
          Li = reflectShadeHit(
            hit, hitPoint, hitNormal, sRad, eps, range,
            diffuseTex, diffuseTexSampler, lodScale, albedoBoost,
            lightDir, lightColor, camPos, gridOrigin, momentsRead, occParams,
            dynTrace, dynBounds
          );
        }

        if (dbg > 0.5) {
          if (dbg < 1.5) { return vec4f(Li, 1.0); }
          if (dbg < 2.5) { return vec4f(weight, 1.0); }
          if (dbg < 3.5) { return vec4f(F0, 1.0); }
          if (dbg < 4.5) { return vec4f(C.xyz, 1.0); }
          return vec4f(select(vec3f(0.0), vec3f(1.0), hit.didHit), 1.0);
        }

        return vec4f(Li * weight, 1.0);
      }
    `,
      [
        bvhConstants,
        consts,
        rayStruct,
        intersectionResultStruct,
        sceneHitStruct,
        bvhIntersectFirstHit,
        dynBvhIntersectFirstHit,
        dynBoundsHit,
        getVertexAttribute,
        getDynVertexAttribute,
        traceScene,
        traceSceneOccluded,
        probeTangentBasis,
        probeJitter,
        probeSampleEnv,
        probeGridHelpers,
        probeRadiusEpsilon,
        probeSurfelCacheRO,
        reflectSampleVndf,
        reflectG2overG1,
        reflectDiffuseLod,
        reflectSampleDiffuse,
        reflectShadeHit,
        // Twelve storage buffers: eight for the two acceleration structures, four for
        // the surfel cache. Two under the WebGPU per-stage cap, which is why the
        // half-res G-Buffer travels as textures rather than as buffers.
        bvh.bvhNode,
        bvh.positionNode,
        bvh.indexNode,
        bvh.colorNode,
        dynBvh.bvhNode,
        dynBvh.positionNode,
        dynBvh.indexNode,
        dynBvh.colorNode,
        surfelsRO,
        momentsRO,
        offsetsAndListRO,
        surfelDepthRO,
      ],
    );

    traceNode = Fn(() => {
      const tid = int(instanceIndex);
      const hx = tid.mod(int(halfW));
      const hy = tid.div(int(halfW));
      const result = tracer({
        hx,
        hy,
        gPos: texture(gA!),
        gNor: texture(gB!),
        gMat: texture(gC!),
        diffuseTex: texture(bvh.diffuseArrayTex),
        diffuseTexSampler: sampler(bvh.diffuseArrayTex),
        envTexture: texture(env),
        envSampler: sampler(env),
        envIntensity: U_ENV_INTENSITY,
        envLod: U_ENV_LOD,
        frame: U_FRAME,
        camPos: U_CAM_POS,
        lightDir: U_LIGHT_DIR,
        lightColor: U_LIGHT_COLOR,
        gridOrigin: U_GRID_ORIGIN,
        momentsRead: U_MOMENTS_READ,
        occParams: U_OCCLUSION_PARAMS,
        roughCut: U_ROUGH_CUT,
        range: U_RANGE,
        lodScale: U_LOD_SCALE,
        albedoBoost: U_ALBEDO_BOOST,
        dynTrace: U_DYN_TRACE,
        dynBounds: dynBvh.influence,
        dbg: U_DEBUG,
      });
      textureStore(traceTex!, ivec2(hx, hy), result);
    })()
      .compute(halfW * halfH)
      .setName('Reflect trace');

    // ------------------------------------------------------------ 3. denoise
    denoiseNode = Fn(() => {
      const tid = int(instanceIndex);
      const hx = tid.mod(int(halfW));
      const hy = tid.div(int(halfW));
      const uv = fullUv(hx, hy);

      const depth = texture(texDepth, uv).r;
      const valid = depth.lessThan(0.999).and(depth.greaterThan(0.0));
      const out = vec3(0).toVar();
      const P = vec3(0).toVar();

      If(valid, () => {
        const viewPos = getViewPosition(uv, depth, U_PROJ_INV);
        P.assign(U_CAM_WORLD.mul(vec4(viewPos, 1.0)).xyz);
        const N = texture(texNormal, uv).xyz.mul(2.0).sub(1.0).normalize();

        // --- spatial ---------------------------------------------------------
        // 3x3, geometry-weighted. Neighbouring pixels under one specular lobe carry
        // usable information about each other and nothing else does, so the taps are
        // rejected by plane and normal exactly the way the probe filter rejects
        // probes — averaging across a silhouette in a mirror smears the reflection
        // off the edge of the object reflecting it.
        const acc = vec3(0).toVar();
        const wsum = float(0).toVar();
        Loop({ start: int(0), end: int(9), type: 'int', name: 'k' }, ({ k }) => {
          const dx = k.mod(int(3)).sub(int(1));
          const dy = k.div(int(3)).sub(int(1));
          const nx = clamp(hx.add(dx), int(0), int(halfW - 1));
          const ny = clamp(hy.add(dy), int(0), int(halfH - 1));
          const nuv = fullUv(nx, ny);

          const nd = texture(texDepth, nuv).r;
          If(nd.lessThan(0.999).and(nd.greaterThan(0.0)), () => {
            const nView = getViewPosition(nuv, nd, U_PROJ_INV);
            const nP = U_CAM_WORLD.mul(vec4(nView, 1.0)).xyz;
            const nN = texture(texNormal, nuv).xyz.mul(2.0).sub(1.0).normalize();
            const t = texture(traceTex!, nuv);
            // Plane epsilon scaled by view depth: a fixed world epsilon is a different
            // number of pixels at every distance, and this filter is in pixels.
            const planeEps = max(float(0.01), viewPos.z.negate().mul(0.01));
            const wPlane = clamp(
              float(1).sub(nP.sub(P).dot(N).abs().div(planeEps)),
              float(0),
              float(1),
            );
            const wNormal = clamp(nN.dot(N).sub(0.9).div(0.1), float(0), float(1));
            const w = wPlane.mul(wNormal).mul(t.w);
            acc.addAssign(t.xyz.mul(w));
            wsum.addAssign(w);
          });
        });

        const centre = texture(traceTex!, uv);
        const filtered = U_FILTER.greaterThan(float(0.5))
          .and(wsum.greaterThan(float(1e-4)))
          .select(acc.div(max(float(1e-4), wsum)), centre.xyz);
        out.assign(filtered);

        // --- temporal --------------------------------------------------------
        // Reprojected by world position through last frame's view-projection, which is
        // the same trick the probe trace reprojects with. Validated by world position
        // rather than by a depth history, so a disocclusion rejects rather than smears.
        If(U_HISTORY_VALID.greaterThan(float(0.5)), () => {
          const clipPos = U_PREV_VIEW_PROJ.mul(vec4(P, 1.0));
          If(clipPos.w.greaterThan(float(1e-6)), () => {
            const ndc = clipPos.xyz.div(clipPos.w);
            // NDC y points up; `hy` counts down from the top, because every stage in
            // this pass reaches its texel through `getViewPosition`, which reads uv.y as
            // `1 - (ndc.y * 0.5 + 0.5)` under the WebGPU coordinate system. Inverting
            // that without the `1 -` mirrors the history lookup about the screen's
            // centreline — and the plane and normal tests below *accept* the mirrored
            // sample wherever one flat surface spans the horizon, so the failure is
            // shimmer rather than a black frame. That is the bug the probe tier was
            // just fixed for; this is the same arithmetic, and it shares the same
            // switch so one ablation moves both denoisers rather than two.
            const flatY = ndc.y.mul(0.5).add(0.5);
            const suv = vec2(
              ndc.x.mul(0.5).add(0.5),
              U_REPROJ_FLIP.greaterThan(float(0.5)).select(float(1).sub(flatY), flatY),
            );
            If(
              suv.x
                .greaterThanEqual(float(0))
                .and(suv.x.lessThan(float(1)))
                .and(suv.y.greaterThanEqual(float(0)))
                .and(suv.y.lessThan(float(1))),
              () => {
                const px = clamp(
                  suv.x.mul(float(halfW)).toInt(),
                  int(0),
                  int(halfW - 1),
                );
                const py = clamp(
                  suv.y.mul(float(halfH)).toInt(),
                  int(0),
                  int(halfH - 1),
                );
                const base = int(U_HIST_PREV).add(
                  py.mul(int(halfW)).add(px).mul(int(2)),
                );
                const hPos = history.element(base.add(int(1)));
                If(hPos.w.greaterThan(float(0.5)), () => {
                  const tol = max(float(0.02), viewPos.z.negate().mul(0.02));
                  If(hPos.xyz.sub(P).length().lessThan(tol), () => {
                    const hCol = history.element(base).xyz;
                    out.assign(hCol.add(out.sub(hCol).mul(U_TEMPORAL)));
                  });
                });
              },
            );
          });
        });
      });

      const cur = int(U_HIST_CUR).add(tid.mul(int(2)));
      history.element(cur).assign(vec4(out, float(1)));
      history
        .element(cur.add(int(1)))
        .assign(vec4(P, valid.select(float(1), float(0))));
      textureStore(denoisedTex!, ivec2(hx, hy), vec4(out, float(1)));
    })()
      .compute(halfW * halfH)
      .setName('Reflect denoise');

    // ----------------------------------------------------------- 4. upsample
    upsampleNode = Fn(() => {
      const tid = int(instanceIndex);
      const x = tid.mod(int(width));
      const y = tid.div(int(width));
      const uv = vec2(
        x.toFloat().add(0.5).div(float(width)),
        y.toFloat().add(0.5).div(float(height)),
      );

      const depth = texture(texDepth, uv).r;
      const valid = depth.lessThan(0.999).and(depth.greaterThan(0.0));
      const out = vec3(0).toVar();
      /**
       * How much of the diffuse gather this pixel is still entitled to.
       *
       * A metal has no diffuse lobe, and the composite — a deferred `gi x albedo` with
       * no material knowledge at all — was giving the chrome sphere a full white diffuse
       * bounce on top of its reflection. The result was a milky ball with a mirror
       * faintly visible inside it. This pass holds the only full-resolution metalness in
       * the frame, so it is the only place that can hand the composite a number to
       * multiply by; the alpha of a texture it already samples is free.
       *
       * 1 wherever this pass has nothing to say, so a scene without metal is unchanged.
       */
      const kD = float(1).toVar();

      If(valid, () => {
        kD.assign(
          clamp(
            float(1).sub(texture(metalRough, uv).r.mul(U_KILL_KD)),
            float(0),
            float(1),
          ),
        );

        const viewPos = getViewPosition(uv, depth, U_PROJ_INV);
        const P = U_CAM_WORLD.mul(vec4(viewPos, 1.0)).xyz;
        const N = texture(texNormal, uv).xyz.mul(2.0).sub(1.0).normalize();

        // Joint bilateral upsample. The four half-res taps that surround this pixel are
        // weighted by the geometry *at their own centres*, reconstructed from the
        // full-res depth buffer rather than stored — one depth fetch is cheaper than a
        // second G-Buffer to keep in step. A tap on the far side of a silhouette scores
        // zero, which is precisely the bleed a plain bilinear stretch could not avoid.
        const half = vec2(
          x.toFloat().add(0.5).div(float(width)).mul(float(halfW)).sub(0.5),
          y.toFloat().add(0.5).div(float(height)).mul(float(halfH)).sub(0.5),
        );
        const bx = half.x.floor();
        const by = half.y.floor();
        const frx = half.x.sub(bx);
        const fry = half.y.sub(by);

        const acc = vec3(0).toVar();
        const wsum = float(0).toVar();
        Loop({ start: int(0), end: int(4), type: 'int', name: 'k' }, ({ k }) => {
          const ox = k.mod(int(2));
          const oy = k.div(int(2));
          const nx = clamp(bx.toInt().add(ox), int(0), int(halfW - 1));
          const ny = clamp(by.toInt().add(oy), int(0), int(halfH - 1));
          const wb = ox
            .equal(int(0))
            .select(float(1).sub(frx), frx)
            .mul(oy.equal(int(0)).select(float(1).sub(fry), fry));

          const nuv = fullUv(nx, ny);
          const nd = texture(texDepth, nuv).r;
          If(nd.lessThan(0.999).and(nd.greaterThan(0.0)), () => {
            const nView = getViewPosition(nuv, nd, U_PROJ_INV);
            const nP = U_CAM_WORLD.mul(vec4(nView, 1.0)).xyz;
            const nN = texture(texNormal, nuv).xyz.mul(2.0).sub(1.0).normalize();
            const planeEps = max(float(0.02), viewPos.z.negate().mul(0.02));
            const wPlane = clamp(
              float(1).sub(nP.sub(P).dot(N).abs().div(planeEps)),
              float(0),
              float(1),
            );
            const wNormal = clamp(nN.dot(N).sub(0.9).div(0.1), float(0), float(1));
            const w = wb.mul(wPlane).mul(wNormal);
            If(w.greaterThan(float(0)), () => {
              acc.addAssign(texture(denoisedTex!, nuv).xyz.mul(w));
              wsum.addAssign(w);
            });
          });
        });

        // Every tap rejected means this pixel has no half-res sample that belongs to it.
        // Emitting nothing is right: a silhouette pixel with no specular estimate is
        // better black than lit by whatever was behind it.
        If(wsum.greaterThan(float(1e-4)), () => {
          out.assign(acc.div(wsum));
        });
      });

      textureStore(outTex!, ivec2(x, y), vec4(out, kD));
    })()
      .compute(width * height)
      .setName('Reflect upsample');

    boundKey = key(gbuffer);
    return true;
  }

  /** True when the chain ran and `outTex` holds this frame's answer. */
  function run(
    renderer: THREE.WebGPURenderer,
    camera: THREE.PerspectiveCamera,
    gbuffer: { target: THREE.RenderTarget },
  ): boolean {
    // Ahead of the `enabled` gate, because `?reflScene=1&refl=0` is the control half of
    // every measurement this tier makes. Injecting only when the tier is on would put
    // two geometry changes into one A/B — a chrome sphere appearing and a reflection
    // appearing — and a difference image could not say which one it measured.
    if (reflectSettings.testScene && probeScene.scene) {
      injectReflectTestScene(probeScene.scene);
    }

    if (!reflectSettings.enabled) return false;
    if (!probeScene.bvh || !probeScene.dynBvh || !probeScene.env) return false;

    resize(gbuffer.target.width, gbuffer.target.height);
    if (!outTex) return false;

    // Nothing glossy on screen means nothing to trace and, more to the point, nothing
    // worth a second scene raster for. This is the branch that makes the tier free on
    // the default Cornell box rather than merely cheap.
    if (!sceneHasGloss(probeScene.scene, renderer.info.frame)) return false;

    renderMaterialGBuffer(renderer, camera);

    if (!upsampleNode || boundKey !== key(gbuffer)) {
      discard();
      if (!build(gbuffer)) return false;
    }

    U_PROJ_INV.value.copy(camera.projectionMatrixInverse);
    U_CAM_WORLD.value.copy(camera.matrixWorld);
    U_CAM_POS.value.copy(camera.position);
    U_FRAME.value = renderer.info.frame;
    U_MOMENTS_READ.value = pool.getOffsets().writeOffset;
    snap_to_surfel_grid_origin(U_GRID_ORIGIN.value, camera.position);

    const light = probeScene.light;
    if (light) {
      U_LIGHT_DIR.value.subVectors(light.position, light.target.position).normalize();
      U_LIGHT_COLOR.value.copy(light.color).multiplyScalar(light.intensity);
    }

    U_ROUGH_CUT.value = reflectSettings.roughnessCutoff;
    U_RANGE.value = reflectSettings.range;
    U_TEMPORAL.value = reflectSettings.temporalAlpha;
    U_FILTER.value = reflectSettings.spatialFilter ? 1 : 0;
    U_LOD_SCALE.value = giKnobs.diffuseLodScale();
    U_DEBUG.value = reflectSettings.debugMode;
    U_KILL_KD.value = reflectSettings.killMetalDiffuse ? 1 : 0;
    U_REPROJ_FLIP.value = probeSettings.reprojectFlipY ? 1 : 0;
    U_HISTORY_VALID.value = hadHistory ? 1 : 0;
    // Answers to the same `?dyntrace=` the integrator and the probes answer to, so one
    // ablation moves all three tiers and a difference cannot be attributed to the wrong
    // one.
    U_DYN_TRACE.value =
      probeSettings.dynamicTracing && (probeScene.dynBvh?.enabled.value ?? 0) > 0
        ? 1
        : 0;

    U_HIST_CUR.value = parity * halfW * halfH * 2;
    U_HIST_PREV.value = (1 - parity) * halfW * halfH * 2;

    renderer.compute(prepareNode!);
    renderer.compute(traceNode!);
    renderer.compute(denoiseNode!);
    renderer.compute(upsampleNode!);

    U_PREV_VIEW_PROJ.value
      .copy(camera.projectionMatrix)
      .multiply(camera.matrixWorldInverse);
    parity = 1 - parity;
    hadHistory = true;
    reflectStats.ran = true;
    reflectTextures.reflection = outTex;

    return true;
  }

  return {
    run,
    getOutputTexture: () => outTex,
    invalidate: () => {
      hadHistory = false;
    },
  };
}
