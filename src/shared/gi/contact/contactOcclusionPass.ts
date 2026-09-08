// @ts-nocheck -- wgslFn kernel with storage-node includes, the integrator's conventions.
import * as THREE from 'three/webgpu';
import { instanceIndex, storage, texture, uniform, wgslFn } from 'three/tsl';
import { constants, intersectionResultStruct, rayStruct } from '../bvh/webgpu/index.js';
import type { DynamicBVHBundle } from '../surfel/dynamicBvh.ts';
import type { ContactBVHBundle } from './contactBvh.ts';
import { contactVisibility } from './boundedTrace.ts';

export interface ContactOcclusionSettings {
  enabled: boolean;
  /** Frames between traces; 1 traces every frame. See the dispatch for what a skip means. */
  traceInterval: number;
  /** How far a contact ray looks, metres. Short on purpose: this is what the surfel gather cannot resolve. */
  radius: number;
  /** Rays per pixel per frame; the history does the rest. */
  rays: number;
  /** Weight of the reprojected history when its depth agrees. */
  historyWeight: number;
  /** How strongly the occlusion darkens indirect light: 1 = physical fraction. */
  intensity: number;
  /** Fraction of the screen resolution the rays are traced at; the composite upsamples. */
  resolutionScale: number;
}

export const DEFAULT_CONTACT_SETTINGS: Readonly<ContactOcclusionSettings> = {
  // Half grid, one ray: +1.1 ms per frame on the beach (scripts/_gpu_frame_probe.mjs,
  // timestamps resolved every frame, headed; quarter grid +0.8 ms). Earlier figures of
  // tens of ms were the composite being rebuilt every frame by a reader object that
  // changed identity each call — a leak, not tracing cost.
  enabled: true,
  // Traced every other frame: the pass keeps its result in a storage buffer the
  // composite reads by parity and carries its own reprojected, depth-tested history,
  // so a skipped frame shows the last trace rather than nothing.
  traceInterval: 2,
  radius: 0.4,
  rays: 1,
  historyWeight: 0.92,
  intensity: 1,
  // Half resolution: +1.1 ms; the history and TAA smooth the signal anyway.
  resolutionScale: 0.5,
};

/**
 * What the composite reads: per pixel `(oct.x, oct.y, visibility, viewDepth)` — the
 * bent normal (octahedral, world space), the visible fraction of the cosine-weighted
 * hemisphere within `radius`, and the view depth the sample was taken at (the history
 * test uses it). Two buffers alternate; `parity` says which one holds this frame.
 */
export interface ContactOcclusionReader {
  /** Storage node (read-only) of the buffer written this frame, and its twin. */
  current: THREE.StorageBufferNode;
  previous: THREE.StorageBufferNode;
  parity: THREE.UniformNode;
  width: number;
  height: number;
}

/** wgslFn reads the first `fn` in a string as the entry point, so the helpers are separate. */
const octEncode = wgslFn(/* wgsl */ `
  fn octEncode( n: vec3f ) -> vec2f {
    let l1 = abs( n.x ) + abs( n.y ) + abs( n.z );
    var p = n.xy / l1;
    if ( n.z < 0.0 ) {
      p = ( 1.0 - abs( p.yx ) ) * vec2f( select( -1.0, 1.0, p.x >= 0.0 ), select( -1.0, 1.0, p.y >= 0.0 ) );
    }
    return p;
  }
`);
const octDecode = wgslFn(/* wgsl */ `
  fn octDecode( p: vec2f ) -> vec3f {
    var n = vec3f( p.x, p.y, 1.0 - abs( p.x ) - abs( p.y ) );
    let t = max( -n.z, 0.0 );
    n.x += select( t, -t, n.x >= 0.0 );
    n.y += select( t, -t, n.y >= 0.0 );
    return normalize( n );
  }
`);

const viewPosAt = wgslFn(/* wgsl */ `
  fn viewPosAt( depthTex: texture_depth_2d, projInv: mat4x4f, px: vec2i, size: vec2f ) -> vec3f {
    let d = textureLoad( depthTex, px, 0 );
    let uv = ( vec2f( px ) + 0.5 ) / size;
    let ndc = vec2f( uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0 );
    let h = projInv * vec4f( ndc, d, 1.0 );
    return h.xyz / h.w;
  }
`);

const KERNEL = /* wgsl */ `
  fn contactKernel(
    depthTex: texture_depth_2d,
    normalTex: texture_2d<f32>,
    blueNoiseTex: texture_2d<f32>,
    camWorld: mat4x4f,
    projInv: mat4x4f,
    prevViewProj: mat4x4f,
    size: vec2f,
    radius: f32,
    rayCount: f32,
    frame: f32,
    historyWeight: f32,
    parity: f32,
    dynTrace: f32,
    dynBounds: vec4f
  ) -> void {
    let i = instanceIndex;
    let width = u32( size.x );
    let height = u32( size.y );
    if ( i >= width * height ) { return; }
    // rays = 0 is a probe: the pass binds and dispatches but does no work.
    if ( rayCount < 0.5 ) { return; }
    let px = vec2u( i % width, i / width );
    // The grid may be coarser than the G-buffer: read the texel at the cell's centre.
    let gsize = vec2f( textureDimensions( depthTex ) );
    let gpx = vec2i( ( vec2f( px ) + 0.5 ) / size * gsize );
    let depth = textureLoad( depthTex, gpx, 0 );
    // Sky/backdrop: fully open, straight up, no depth.
    var out = vec4f( 0.0, 0.0, 1.0, 0.0 );

    if ( depth < 1.0 ) {
      let viewPos = viewPosAt( depthTex, projInv, gpx, gsize );
      let worldPos = ( camWorld * vec4f( viewPos, 1.0 ) ).xyz;
      // The G-buffer normal is the *shading* normal (three's normalWorld is bump-mapped
      // since r177): a hemisphere around it dips under the real surface and every ray
      // that does so hits the surface itself. Rays are generated around the geometric
      // normal from depth derivatives instead — the side with the smaller depth step,
      // so edges do not smear — oriented to agree with the shading normal.
      let nShade = normalize( textureLoad( normalTex, gpx, 0 ).xyz * 2.0 - 1.0 );
      let maxPx = vec2i( gsize ) - vec2i( 1 );
      let pL = viewPosAt( depthTex, projInv, max( gpx - vec2i( 1, 0 ), vec2i( 0 ) ), gsize );
      let pR = viewPosAt( depthTex, projInv, min( gpx + vec2i( 1, 0 ), maxPx ), gsize );
      let pU = viewPosAt( depthTex, projInv, max( gpx - vec2i( 0, 1 ), vec2i( 0 ) ), gsize );
      let pD = viewPosAt( depthTex, projInv, min( gpx + vec2i( 0, 1 ), maxPx ), gsize );
      let dxv = select( pR - viewPos, viewPos - pL, abs( pL.z - viewPos.z ) < abs( pR.z - viewPos.z ) );
      let dyv = select( pD - viewPos, viewPos - pU, abs( pU.z - viewPos.z ) < abs( pD.z - viewPos.z ) );
      var nGeomView = normalize( cross( dxv, dyv ) );
      var nWorld = normalize( ( camWorld * vec4f( nGeomView, 0.0 ) ).xyz );
      if ( dot( nWorld, nShade ) < 0.0 ) { nWorld = -nWorld; }
      // A degenerate derivative (depth discontinuity on both sides) falls back to shading.
      if ( !( dot( nWorld, nWorld ) > 0.5 ) ) { nWorld = nShade; }

      // Tangent frame for the cosine-weighted hemisphere.
      let helper = select( vec3f( 0.0, 1.0, 0.0 ), vec3f( 1.0, 0.0, 0.0 ), abs( nWorld.y ) > 0.99 );
      let tangent = normalize( cross( helper, nWorld ) );
      let bitangent = cross( nWorld, tangent );
      // Blue noise per pixel, advanced per frame and per ray by the R2 sequence so the
      // history sees a different pair every frame and the pattern stays blue.
      let bn = textureLoad( blueNoiseTex, vec2i( px % 128u ), 0 ).xy;
      let bias = 0.004 + 0.0015 * length( viewPos );
      let origin = worldPos + nWorld * bias;
      let rays = u32( rayCount );
      var visible = 0.0;
      var bent = vec3f( 0.0 );
      for ( var r = 0u; r < rays; r = r + 1u ) {
        let k = frame * rayCount + f32( r );
        let u = fract( bn + vec2f( 0.7548776662, 0.5698402910 ) * k );
        let phi = 6.28318530718 * u.x;
        // Cosine-weighted, with the lowest 12° of elevation folded away: grazing rays
        // carry ~5 % of the integral and cost most of the traversal, skimming every
        // leaf box along a finely tessellated surface.
        let cosTheta = sqrt( 1.0 - u.y * 0.96 );
        let sinTheta = sqrt( 1.0 - cosTheta * cosTheta );
        let d = normalize( tangent * ( cos( phi ) * sinTheta ) + bitangent * ( sin( phi ) * sinTheta ) + nWorld * cosTheta );
        let v = contactVisibility( origin + d * 0.01, d, radius, dynTrace, dynBounds );
        visible = visible + v;
        bent = bent + d * v;
      }
      var ao = visible / rayCount;
      var bentNormal = nWorld;
      if ( visible > 0.0 ) { bentNormal = normalize( bent ); }

      // History: reproject through last frame's view-projection, accept when the
      // stored view depth agrees with where this point was, then blend.
      let prevClip = prevViewProj * vec4f( worldPos, 1.0 );
      if ( prevClip.w > 0.0 ) {
        let prevNdc = prevClip.xy / prevClip.w;
        let prevUv = vec2f( prevNdc.x * 0.5 + 0.5, 0.5 - prevNdc.y * 0.5 );
        if ( all( prevUv >= vec2f( 0.0 ) ) && all( prevUv <= vec2f( 1.0 ) ) ) {
          let ppx = min( vec2u( prevUv * size ), vec2u( width - 1u, height - 1u ) );
          let pi = ppx.y * width + ppx.x;
          var hist = contactB.value[ pi ];
          if ( parity > 0.5 ) { hist = contactA.value[ pi ]; }
          let depthThen = prevClip.w;
          if ( hist.w > 0.0 && abs( hist.w - depthThen ) < 0.03 * depthThen + 0.02 ) {
            ao = mix( ao, hist.z, historyWeight );
            bentNormal = normalize( mix( bentNormal, octDecode( hist.xy ), historyWeight ) );
          }
        }
      }
      out = vec4f( octEncode( bentNormal ), ao, -viewPos.z );
    }

    if ( parity > 0.5 ) { contactB.value[ i ] = out; } else { contactA.value[ i ] = out; }
  }
`;

/**
 * Contact occlusion by short rays against the real scene (static BVH + movers), not
 * the depth buffer: what lies behind an edge or off screen still occludes. Per pixel
 * per frame `rays` cosine-weighted rays of length `radius` start at the G-buffer
 * surface; the visible fraction is the occlusion of *indirect* light (direct light is
 * already shadowed), and the mean open direction is a bent normal for sky and specular
 * occlusion. A reprojected history with a depth test accumulates the estimate; the
 * frame's TAA smooths what is left.
 *
 * Reads the surfel GI's own G-buffer (world normal, depth), which the same jittered
 * camera rendered this frame, so it runs in the frame loop right after `gi.update`.
 * Output is a pair of storage buffers the composite reads by pixel index.
 */
export class ContactOcclusionPass {
  private static allocations = 0;
  readonly settings: ContactOcclusionSettings;
  private width = 0;
  private height = 0;
  private buffers: [THREE.StorageBufferAttribute, THREE.StorageBufferAttribute] | null = null;
  private writeNodes: [THREE.StorageBufferNode, THREE.StorageBufferNode] | null = null;
  private readNodes: [THREE.StorageBufferNode, THREE.StorageBufferNode] | null = null;
  private kernel: THREE.ComputeNode | null = null;
  private sinceTrace = 0;
  private boundStatic: ContactBVHBundle | null = null;
  private boundDynamic: DynamicBVHBundle | null = null;
  private boundDepth: THREE.Texture | null = null;
  private frame = 0;
  private historyValid = false;
  private readonly prevViewProjection = new THREE.Matrix4();

  private readonly uCamWorld = uniform(new THREE.Matrix4());
  private readonly uProjInv = uniform(new THREE.Matrix4());
  private readonly uPrevViewProj = uniform(new THREE.Matrix4());
  private readonly uSize = uniform(new THREE.Vector2(1, 1));
  private readonly uRadius = uniform(0.5);
  private readonly uRayCount = uniform(2);
  private readonly uFrame = uniform(0);
  private readonly uHistoryWeight = uniform(0.9);
  readonly uParity = uniform(0);
  private readonly uDynTrace = uniform(0);

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly blueNoise: THREE.Texture,
    settings: Partial<ContactOcclusionSettings> = {},
  ) {
    this.settings = { ...DEFAULT_CONTACT_SETTINGS, ...settings };
  }

  private readerObject: ContactOcclusionReader | null = null;

  /**
   * The buffers the composite reads, or null before the first frame ran. One object per
   * allocation: the caller compares it by identity to decide whether the composite
   * must be rebuilt, and a fresh object every call rebuilt it every frame — new render
   * targets and shader programs each frame until memory ran out (2026-09-08).
   */
  get reader(): ContactOcclusionReader | null {
    if (!this.readNodes) return null;
    if (!this.readerObject) {
      this.readerObject = { current: this.readNodes[0], previous: this.readNodes[1], parity: this.uParity, width: this.width, height: this.height };
    }
    return this.readerObject;
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  setEnabled(value: boolean): void {
    this.settings.enabled = value;
    this.historyValid = false;
  }

  invalidateHistory(): void {
    this.historyValid = false;
  }

  /**
   * Runs the pass for this frame. `staticBvh` is the full-detail contact tree (see
   * contactBvh.ts), `depth`/`normal` the GI G-buffer textures (world normal encoded
   * 0.5 + 0.5 in rgb). Returns false when nothing ran (disabled, no BVH).
   */
  update(
    staticBvh: ContactBVHBundle | null,
    dynamicBvh: DynamicBVHBundle | null,
    depth: THREE.Texture,
    normal: THREE.Texture,
    width: number,
    height: number,
    dynamicTracing: boolean,
  ): boolean {
    if (!this.settings.enabled || !staticBvh || !dynamicBvh) return false;
    const scale = Math.min(1, Math.max(0.25, this.settings.resolutionScale));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    if (width !== this.width || height !== this.height) this.allocate(width, height);
    if (staticBvh !== this.boundStatic || dynamicBvh !== this.boundDynamic || depth !== this.boundDepth || !this.kernel) {
      this.boundStatic = staticBvh;
      this.boundDynamic = dynamicBvh;
      this.boundDepth = depth;
      this.buildKernel(staticBvh, dynamicBvh, depth, normal);
      this.historyValid = false;
    }

    // Amortised (see traceInterval): on a skipped frame nothing is dispatched and
    // neither the parity nor the previous view-projection moves, so the composite
    // reads the last trace and the next one reprojects from where that trace stood.
    const interval = Math.max(1, Math.round(this.settings.traceInterval));
    this.sinceTrace = (this.sinceTrace + 1) % interval;
    if (this.sinceTrace !== 0 && this.historyValid) return true;

    const cam = this.camera;
    this.uCamWorld.value.copy(cam.matrixWorld);
    this.uProjInv.value.copy(cam.projectionMatrixInverse);
    this.uPrevViewProj.value.copy(this.prevViewProjection);
    this.uSize.value.set(width, height);
    this.uRadius.value = this.settings.radius;
    this.uRayCount.value = Math.max(0, Math.round(this.settings.rays));
    this.uFrame.value = this.frame;
    this.uHistoryWeight.value = this.historyValid ? this.settings.historyWeight : 0;
    this.uParity.value = this.frame & 1;
    this.uDynTrace.value = dynamicTracing && dynamicBvh.enabled.value > 0 ? 1 : 0;

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
    const make = () => new THREE.StorageBufferAttribute(new Float32Array(count * 4), 4);
    this.buffers = [make(), make()];
    this.writeNodes = [
      storage(this.buffers[0], 'vec4', count).setName('contactA'),
      storage(this.buffers[1], 'vec4', count).setName('contactB'),
    ];
    // Unique names per allocation: a reallocated grid must not collide with the read
    // nodes a rebuilt composite may still hold for a frame.
    const id = ContactOcclusionPass.allocations++;
    this.readNodes = [
      storage(this.buffers[0], 'vec4', count).toReadOnly().setName(`contactRead${id}A`),
      storage(this.buffers[1], 'vec4', count).toReadOnly().setName(`contactRead${id}B`),
    ];
    this.kernel = null;
    this.readerObject = null;
    this.historyValid = false;
  }

  private buildKernel(staticBvh: ContactBVHBundle, dynamicBvh: DynamicBVHBundle, depth: THREE.Texture, normal: THREE.Texture): void {
    const fn = wgslFn(KERNEL, [
      viewPosAt,
      octEncode,
      octDecode,
      contactVisibility,
      rayStruct,
      intersectionResultStruct,
      constants,
      staticBvh.bvhNode,
      staticBvh.positionNode,
      staticBvh.indexNode,
      dynamicBvh.bvhNode,
      dynamicBvh.positionNode,
      dynamicBvh.indexNode,
      dynamicBvh.colorNode,
      this.writeNodes![0],
      this.writeNodes![1],
    ]);
    this.kernel = fn({
      depthTex: texture(depth),
      normalTex: texture(normal),
      blueNoiseTex: texture(this.blueNoise),
      camWorld: this.uCamWorld,
      projInv: this.uProjInv,
      prevViewProj: this.uPrevViewProj,
      size: this.uSize,
      radius: this.uRadius,
      rayCount: this.uRayCount,
      frame: this.uFrame,
      historyWeight: this.uHistoryWeight,
      parity: this.uParity,
      dynTrace: this.uDynTrace,
      dynBounds: dynamicBvh.influence,
    })
      .compute(this.width * this.height)
      .setName('Contact Occlusion');
  }

  dispose(): void {
    this.buffers = null;
    this.writeNodes = null;
    this.readNodes = null;
    this.kernel = null;
  }
}
