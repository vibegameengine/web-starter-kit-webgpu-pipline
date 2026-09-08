// @ts-nocheck -- wgslFn kernel with storage-node includes, the integrator's conventions.
import * as THREE from 'three/webgpu';
import { instanceIndex, sampler, storage, texture, uniform, wgslFn } from 'three/tsl';
import { constants, intersectionResultStruct, rayStruct, bvhIntersectFirstHit, getVertexAttribute, intersectsBounds, bvhNodeStruct } from '../bvh/webgpu/index.js';
import {
  dynBoundsHit,
  dynBvhIntersectFirstHit,
  getDynVertexAttribute,
  sceneHitStruct,
  traceScene,
  traceSceneOccluded,
  type DynamicBVHBundle,
} from '../surfel/dynamicBvh.ts';
import { giLightConsts, giOccluded, giSampleLight, giShadeHit, giVisibility } from '../surfel/hitShading.ts';
import { envEquirectUV, sampleDiffuseArray } from '../surfel/surfelIntegratePass.ts';
import { giLightsTexture, U_GI_LIGHT_COUNT, U_GI_LIGHT_SAMPLES, U_GI_MEDIUM } from '../surfel/sceneLights.ts';
import type { ContactBVHBundle } from '../contact/contactBvh.ts';

export interface ReflectionSettings {
  enabled: boolean;
  /** Surfaces rougher than this get no traced reflection (Lumen's default is 0.4). */
  maxRoughness: number;
  /** Weight of the reprojected history when its depth agrees. */
  historyWeight: number;
  /** Multiplier on the traced radiance; 1 = physical. */
  intensity: number;
  /** Fraction of the screen resolution the rays are traced at. */
  resolutionScale: number;
  /** Screen-trace steps before the ray is handed to the BVH. */
  screenSteps: number;
}

export const DEFAULT_REFLECTION_SETTINGS: Readonly<ReflectionSettings> = {
  enabled: true,
  // 0.45: the waxy leaves (0.30) still reflect the sky, but the lobe of anything
  // rougher is too wide for one ray a frame to converge on a moving surface.
  maxRoughness: 0.45,
  historyWeight: 0.85,
  intensity: 1,
  resolutionScale: 0.5,
  screenSteps: 40,
};

/** Per pixel `(radiance.rgb, confidence)`; two buffers alternate by `parity`. */
export interface ReflectionReader {
  current: THREE.StorageBufferNode;
  previous: THREE.StorageBufferNode;
  parity: THREE.UniformNode;
  width: number;
  height: number;
}

const viewPosAt = wgslFn(/* wgsl */ `
  fn reflViewPosAt( depthTex: texture_depth_2d, projInv: mat4x4f, px: vec2i, size: vec2f ) -> vec3f {
    let d = textureLoad( depthTex, px, 0 );
    let uv = ( vec2f( px ) + 0.5 ) / size;
    let ndc = vec2f( uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0 );
    let h = projInv * vec4f( ndc, d, 1.0 );
    return h.xyz / h.w;
  }
`);

/** View-space depth (positive) of the G-buffer at a uv, or -1 off screen. */
const sceneDepthAt = wgslFn(/* wgsl */ `
  fn reflSceneDepthAt( depthTex: texture_depth_2d, projInv: mat4x4f, uv: vec2f ) -> f32 {
    let gsize = vec2f( textureDimensions( depthTex ) );
    let px = vec2i( clamp( uv, vec2f( 0.0 ), vec2f( 0.9999 ) ) * gsize );
    let d = textureLoad( depthTex, px, 0 );
    if ( d >= 1.0 ) { return 1e9; }
    let ndc = vec2f( uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0 );
    let h = projInv * vec4f( ndc, d, 1.0 );
    return -( h.z / h.w );
  }
`);

const KERNEL = /* wgsl */ `
  fn reflectKernel(
    depthTex: texture_depth_2d,
    normalTex: texture_2d<f32>,
    specTex: texture_2d<f32>,
    colorTex: texture_2d<f32>,
    colorSampler: sampler,
    blueNoiseTex: texture_2d<f32>,
    envTex: texture_2d<f32>,
    envSampler: sampler,
    envIntensity: f32,
    lightsTex: texture_2d<f32>,
    lightCount: u32,
    lightSamples: u32,
    medium: vec4f,
    diffuseTex: texture_2d_array<f32>,
    diffuseSampler: sampler,
    camWorld: mat4x4f,
    view: mat4x4f,
    proj: mat4x4f,
    projInv: mat4x4f,
    prevViewProj: mat4x4f,
    size: vec2f,
    frame: f32,
    historyWeight: f32,
    parity: f32,
    maxRoughness: f32,
    screenSteps: f32,
    dynTrace: f32,
    dynBounds: vec4f,
    ambient: vec3f
  ) -> void {
    let i = instanceIndex;
    let width = u32( size.x );
    let height = u32( size.y );
    if ( i >= width * height ) { return; }
    let px = vec2u( i % width, i / width );
    let gsize = vec2f( textureDimensions( depthTex ) );
    let gpx = vec2i( ( vec2f( px ) + 0.5 ) / size * gsize );
    let depth = textureLoad( depthTex, gpx, 0 );
    var out = vec4f( 0.0 );

    let spec = textureLoad( specTex, gpx, 0 );
    let roughness = clamp( spec.a, 0.02, 1.0 );
    let f0 = spec.rgb;
    if ( depth < 1.0 && roughness <= maxRoughness && max( f0.r, max( f0.g, f0.b ) ) > 0.005 ) {
      let viewPos = reflViewPosAt( depthTex, projInv, gpx, gsize );
      let worldPos = ( camWorld * vec4f( viewPos, 1.0 ) ).xyz;
      let camPos = camWorld[ 3 ].xyz;
      let n = normalize( textureLoad( normalTex, gpx, 0 ).xyz * 2.0 - 1.0 );
      let v = normalize( camPos - worldPos );

      // GGX half-vector sample (Walter 2007), one per cell per frame; the history
      // and the frame's TAA integrate the lobe over time.
      let bn = textureLoad( blueNoiseTex, vec2i( px % 128u ), 0 ).xy;
      let u = fract( bn + vec2f( 0.7548776662, 0.5698402910 ) * frame );
      let alpha = roughness * roughness;
      let cosH = sqrt( ( 1.0 - u.y ) / ( 1.0 + ( alpha * alpha - 1.0 ) * u.y ) );
      let sinH = sqrt( 1.0 - cosH * cosH );
      let phi = 6.28318530718 * u.x;
      let helper = select( vec3f( 0.0, 1.0, 0.0 ), vec3f( 1.0, 0.0, 0.0 ), abs( n.y ) > 0.99 );
      let t = normalize( cross( helper, n ) );
      let b = cross( n, t );
      let h = normalize( t * ( cos( phi ) * sinH ) + b * ( sin( phi ) * sinH ) + n * cosH );
      var l = reflect( -v, h );
      if ( dot( l, n ) < 0.02 ) { l = reflect( l, n ); }

      var radiance = vec3f( 0.0 );
      var found = false;

      // --- 1. screen trace in view space against the G-buffer depth ------------
      let dirV = normalize( ( view * vec4f( l, 0.0 ) ).xyz );
      let startV = viewPos + normalize( ( view * vec4f( n, 0.0 ) ).xyz ) * 0.02;
      let steps = u32( screenSteps );
      let jitter = fract( bn.x + 0.618034 * frame );
      var tPrev = 0.0;
      var stepLen = max( 0.04, length( viewPos ) * 0.01 );
      var tNow = stepLen * jitter;
      for ( var s = 0u; s < steps; s = s + 1u ) {
        let p = startV + dirV * tNow;
        let clip = proj * vec4f( p, 1.0 );
        if ( clip.w <= 0.01 ) { break; }
        let ndc = clip.xy / clip.w;
        let uv = vec2f( ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5 );
        if ( any( uv < vec2f( 0.0 ) ) || any( uv > vec2f( 1.0 ) ) ) { break; }
        let sceneZ = reflSceneDepthAt( depthTex, projInv, uv );
        let rayZ = -p.z;
        let thickness = 0.25 + 0.04 * tNow;
        if ( rayZ > sceneZ && rayZ < sceneZ + thickness ) {
          // Refine between the last miss and this hit, then read last frame's colour.
          var lo = tPrev;
          var hi = tNow;
          for ( var r = 0u; r < 4u; r = r + 1u ) {
            let mid = 0.5 * ( lo + hi );
            let pm = startV + dirV * mid;
            let cm = proj * vec4f( pm, 1.0 );
            let um = vec2f( cm.x / cm.w * 0.5 + 0.5, 0.5 - cm.y / cm.w * 0.5 );
            if ( -pm.z > reflSceneDepthAt( depthTex, projInv, um ) ) { hi = mid; } else { lo = mid; }
          }
          let ph = startV + dirV * hi;
          let ch = proj * vec4f( ph, 1.0 );
          let uh = vec2f( ch.x / ch.w * 0.5 + 0.5, 0.5 - ch.y / ch.w * 0.5 );
          // Fade toward the screen edge so the hand-over to the BVH is soft.
          let edge = min( min( uh.x, 1.0 - uh.x ), min( uh.y, 1.0 - uh.y ) );
          let fade = clamp( edge / 0.08, 0.0, 1.0 );
          if ( fade > 0.0 ) {
            radiance = textureSampleLevel( colorTex, colorSampler, uh, 0.0 ).rgb * fade;
            // Partial credit at the edge: the rest comes from the world trace below.
            if ( fade >= 1.0 ) { found = true; }
            else {
              var ray: Ray;
              ray.origin = worldPos + n * 0.01;
              ray.direction = l;
              let hit = traceScene( ray, dynTrace, dynBounds );
              radiance = radiance + shadeReflectionHit( hit, ray, lightsTex, lightCount, lightSamples, medium, diffuseTex, diffuseSampler, envTex, envSampler, envIntensity, dynTrace, dynBounds, ambient, bn.y ) * ( 1.0 - fade );
              found = true;
            }
          }
          break;
        }
        tPrev = tNow;
        stepLen = stepLen * 1.09;
        tNow = tNow + stepLen;
      }

      // --- 2. the world: BVH closest hit, shaded by the same code the GI uses ----
      if ( !found ) {
        var ray: Ray;
        ray.origin = worldPos + n * 0.01;
        ray.direction = l;
        let hit = traceScene( ray, dynTrace, dynBounds );
        radiance = shadeReflectionHit( hit, ray, lightsTex, lightCount, lightSamples, medium, diffuseTex, diffuseSampler, envTex, envSampler, envIntensity, dynTrace, dynBounds, ambient, bn.y );
      }

      // Firefly clamp: the environment holds the sun at ~65000 and a single sample
      // of it would flash for frames. Radiance is limited to a luminance of 4 (the
      // brightest lit sand is ~1), which keeps sky and lit surfaces intact.
      let lum = dot( radiance, vec3f( 0.2126, 0.7152, 0.0722 ) );
      if ( lum > 4.0 ) { radiance = radiance * ( 4.0 / lum ); }

      // --- history ----------------------------------------------------------------
      var conf = 1.0;
      let prevClip = prevViewProj * vec4f( worldPos, 1.0 );
      if ( prevClip.w > 0.0 ) {
        let prevNdc = prevClip.xy / prevClip.w;
        let prevUv = vec2f( prevNdc.x * 0.5 + 0.5, 0.5 - prevNdc.y * 0.5 );
        if ( all( prevUv >= vec2f( 0.0 ) ) && all( prevUv <= vec2f( 1.0 ) ) ) {
          let ppx = min( vec2u( prevUv * size ), vec2u( width - 1u, height - 1u ) );
          let pi = ppx.y * width + ppx.x;
          var hist = reflectB.value[ pi ];
          if ( parity > 0.5 ) { hist = reflectA.value[ pi ]; }
          let depthThen = prevClip.w;
          let histDepth = reflectDepthB.value[ pi ];
          let histDepthA = reflectDepthA.value[ pi ];
          let dThen = select( histDepth, histDepthA, parity > 0.5 );
          if ( dThen > 0.0 && abs( dThen - depthThen ) < 0.03 * depthThen + 0.02 && hist.a > 0.0 ) {
            radiance = mix( radiance, hist.rgb, historyWeight );
          }
        }
      }
      out = vec4f( radiance, conf );
    }

    if ( parity > 0.5 ) { reflectB.value[ i ] = out; reflectDepthB.value[ i ] = -( reflViewPosAt( depthTex, projInv, gpx, gsize ).z ); }
    else { reflectA.value[ i ] = out; reflectDepthA.value[ i ] = -( reflViewPosAt( depthTex, projInv, gpx, gsize ).z ); }
  }
`;

/** Radiance leaving a world hit toward the ray, or the environment when it missed. */
const shadeReflectionHit = wgslFn(
  /* wgsl */ `
  fn shadeReflectionHit(
    hit: SceneHit, ray: Ray,
    lightsTex: texture_2d<f32>, lightCount: u32, lightSamples: u32, medium: vec4f,
    diffuseTex: texture_2d_array<f32>, diffuseSampler: sampler,
    envTex: texture_2d<f32>, envSampler: sampler, envIntensity: f32,
    dynTrace: f32, dynBounds: vec4f, ambient: vec3f, rnd: f32
  ) -> vec3f {
    if ( !hit.didHit ) {
      let uv = envEquirectUV( ray.direction );
      return textureSampleLevel( envTex, envSampler, uv, 2.0 ).rgb * envIntensity;
    }
    let p = ray.origin + ray.direction * hit.dist;
    var n = normalize( hit.normal );
    if ( dot( n, ray.direction ) > 0.0 ) { n = -n; }
    let matId = i32( round( hit.attrib.z ) );
    let albedo = sampleDiffuseArray( diffuseTex, diffuseSampler, hit.attrib.xy, matId, 2.0 );
    let direct = giShadeHit( lightsTex, p, n, albedo, 0.002, dynTrace, dynBounds, lightCount, lightSamples, rnd, medium, diffuseTex, diffuseSampler );
    // Indirect at the hit: the mean environment as a flat ambient. The surfel cache
    // would be the right source; its hash-grid bindings do not fit this kernel yet.
    return direct + albedo * ambient;
  }
`,
  [sceneHitStruct, rayStruct, envEquirectUV, sampleDiffuseArray, giShadeHit, constants],
);

/**
 * Specular reflections: a GGX-sampled ray per cell, traced first against the screen
 * (this frame's G-buffer depth, last frame's resolved colour) and, when the screen has
 * no answer, against the full-detail static tree plus the movers — shaded by the same
 * light list and shadow rays the GI uses, with the environment behind everything. A
 * reprojected, depth-tested history integrates the lobe; the composite applies the
 * split-sum specular BRDF (three's DFG LUT) and the contact bent-cone occlusion.
 *
 * Runs in the frame loop after the GI and contact passes on the GI G-buffer, whose
 * third attachment carries (specularColor, roughness).
 */
export class ReflectionPass {
  private static allocations = 0;
  readonly settings: ReflectionSettings;
  private width = 0;
  private height = 0;
  private buffers: THREE.StorageBufferAttribute[] | null = null;
  private writeNodes: THREE.StorageBufferNode[] | null = null;
  private readNodes: THREE.StorageBufferNode[] | null = null;
  private readerObject: ReflectionReader | null = null;
  private kernel: THREE.ComputeNode | null = null;
  private boundStatic: ContactBVHBundle | null = null;
  private boundDynamic: DynamicBVHBundle | null = null;
  private boundColor: THREE.Texture | null = null;
  private frame = 0;
  private historyValid = false;
  private readonly prevViewProjection = new THREE.Matrix4();

  private readonly uCamWorld = uniform(new THREE.Matrix4());
  private readonly uView = uniform(new THREE.Matrix4());
  private readonly uProj = uniform(new THREE.Matrix4());
  private readonly uProjInv = uniform(new THREE.Matrix4());
  private readonly uPrevViewProj = uniform(new THREE.Matrix4());
  private readonly uSize = uniform(new THREE.Vector2(1, 1));
  private readonly uFrame = uniform(0);
  private readonly uHistoryWeight = uniform(0.85);
  readonly uParity = uniform(0);
  private readonly uMaxRoughness = uniform(0.55);
  private readonly uScreenSteps = uniform(40);
  private readonly uDynTrace = uniform(0);
  private readonly uEnvIntensity = uniform(1);
  private readonly uAmbient = uniform(new THREE.Color(0.1, 0.12, 0.15));

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly blueNoise: THREE.Texture,
    private readonly environment: THREE.Texture,
    ambient: THREE.Color,
    settings: Partial<ReflectionSettings> = {},
  ) {
    this.settings = { ...DEFAULT_REFLECTION_SETTINGS, ...settings };
    this.uAmbient.value.copy(ambient);
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  setEnabled(value: boolean): void {
    this.settings.enabled = value;
    this.historyValid = false;
  }

  get reader(): ReflectionReader | null {
    if (!this.readNodes) return null;
    if (!this.readerObject) {
      this.readerObject = { current: this.readNodes[0], previous: this.readNodes[1], parity: this.uParity, width: this.width, height: this.height };
    }
    return this.readerObject;
  }

  /**
   * Runs the pass. `color` is last frame's resolved colour (the TAA history), `spec`
   * the GI G-buffer's (specularColor, roughness) attachment. Returns false when idle.
   */
  update(
    staticBvh: ContactBVHBundle | null,
    dynamicBvh: DynamicBVHBundle | null,
    diffuseArray: THREE.Texture | null,
    depth: THREE.Texture,
    normal: THREE.Texture,
    spec: THREE.Texture,
    color: THREE.Texture,
    width: number,
    height: number,
    envIntensity: number,
  ): boolean {
    if (!this.settings.enabled || !staticBvh || !dynamicBvh || !diffuseArray) return false;
    const scale = Math.min(1, Math.max(0.25, this.settings.resolutionScale));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    if (width !== this.width || height !== this.height) this.allocate(width, height);
    if (staticBvh !== this.boundStatic || dynamicBvh !== this.boundDynamic || color !== this.boundColor || !this.kernel) {
      this.boundStatic = staticBvh;
      this.boundDynamic = dynamicBvh;
      this.boundColor = color;
      this.buildKernel(staticBvh, dynamicBvh, diffuseArray, depth, normal, spec, color);
      this.historyValid = false;
    }
    const cam = this.camera;
    this.uCamWorld.value.copy(cam.matrixWorld);
    this.uView.value.copy(cam.matrixWorldInverse);
    this.uProj.value.copy(cam.projectionMatrix);
    this.uProjInv.value.copy(cam.projectionMatrixInverse);
    this.uPrevViewProj.value.copy(this.prevViewProjection);
    this.uSize.value.set(width, height);
    this.uFrame.value = this.frame;
    this.uHistoryWeight.value = this.historyValid ? this.settings.historyWeight : 0;
    this.uParity.value = this.frame & 1;
    this.uMaxRoughness.value = this.settings.maxRoughness;
    this.uScreenSteps.value = Math.max(4, Math.round(this.settings.screenSteps));
    this.uDynTrace.value = dynamicBvh.enabled.value > 0 ? 1 : 0;
    this.uEnvIntensity.value = envIntensity;

    this.renderer.compute(this.kernel);
    this.prevViewProjection.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.historyValid = true;
    this.frame++;
    return true;
  }

  private allocate(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const count = width * height;
    const id = ReflectionPass.allocations++;
    const vec4Buffer = () => new THREE.StorageBufferAttribute(new Float32Array(count * 4), 4);
    const floatBuffer = () => new THREE.StorageBufferAttribute(new Float32Array(count), 1);
    this.buffers = [vec4Buffer(), vec4Buffer(), floatBuffer(), floatBuffer()];
    this.writeNodes = [
      storage(this.buffers[0], 'vec4', count).setName('reflectA'),
      storage(this.buffers[1], 'vec4', count).setName('reflectB'),
      storage(this.buffers[2], 'float', count).setName('reflectDepthA'),
      storage(this.buffers[3], 'float', count).setName('reflectDepthB'),
    ];
    this.readNodes = [
      storage(this.buffers[0], 'vec4', count).toReadOnly().setName(`reflectRead${id}A`),
      storage(this.buffers[1], 'vec4', count).toReadOnly().setName(`reflectRead${id}B`),
    ];
    this.readerObject = null;
    this.kernel = null;
    this.historyValid = false;
  }

  private buildKernel(
    staticBvh: ContactBVHBundle,
    dynamicBvh: DynamicBVHBundle,
    diffuseArray: THREE.Texture,
    depth: THREE.Texture,
    normal: THREE.Texture,
    spec: THREE.Texture,
    color: THREE.Texture,
  ): void {
    const fn = wgslFn(KERNEL, [
      viewPosAt,
      sceneDepthAt,
      shadeReflectionHit,
      traceScene,
      traceSceneOccluded,
      bvhIntersectFirstHit,
      dynBvhIntersectFirstHit,
      dynBoundsHit,
      getVertexAttribute,
      getDynVertexAttribute,
      intersectsBounds,
      giLightConsts,
      giOccluded,
      giVisibility,
      giSampleLight,
      giShadeHit,
      sceneHitStruct,
      rayStruct,
      bvhNodeStruct,
      intersectionResultStruct,
      constants,
      staticBvh.bvhNode,
      staticBvh.positionNode,
      staticBvh.indexNode,
      staticBvh.attributeNode,
      dynamicBvh.bvhNode,
      dynamicBvh.positionNode,
      dynamicBvh.indexNode,
      dynamicBvh.colorNode,
      ...this.writeNodes!,
    ]);
    this.kernel = fn({
      depthTex: texture(depth),
      normalTex: texture(normal),
      specTex: texture(spec),
      colorTex: texture(color),
      colorSampler: sampler(color),
      blueNoiseTex: texture(this.blueNoise),
      envTex: texture(this.environment),
      envSampler: sampler(this.environment),
      envIntensity: this.uEnvIntensity,
      lightsTex: giLightsTexture,
      lightCount: U_GI_LIGHT_COUNT,
      lightSamples: U_GI_LIGHT_SAMPLES,
      medium: U_GI_MEDIUM,
      diffuseTex: texture(diffuseArray),
      diffuseSampler: sampler(diffuseArray),
      camWorld: this.uCamWorld,
      view: this.uView,
      proj: this.uProj,
      projInv: this.uProjInv,
      prevViewProj: this.uPrevViewProj,
      size: this.uSize,
      frame: this.uFrame,
      historyWeight: this.uHistoryWeight,
      parity: this.uParity,
      maxRoughness: this.uMaxRoughness,
      screenSteps: this.uScreenSteps,
      dynTrace: this.uDynTrace,
      dynBounds: dynamicBvh.influence,
      ambient: this.uAmbient,
    })
      .compute(this.width * this.height)
      .setName('Reflections');
  }

  dispose(): void {
    this.buffers = null;
    this.writeNodes = null;
    this.readNodes = null;
    this.readerObject = null;
    this.kernel = null;
  }
}
