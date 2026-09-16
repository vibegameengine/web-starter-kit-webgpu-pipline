import * as THREE from 'three/webgpu';
import { Inspector } from 'three/addons/inspector/Inspector.js';

export interface RendererBundle {
  renderer: THREE.WebGPURenderer;
  container: HTMLElement;
}

/**
 * WebGPU renderer, configured per the colour discipline in CLAUDE.md §3:
 * albedo is sRGB, data is linear, tone mapping is filmic and happens exactly once,
 * at the end.
 *
 * `antialias: false` is deliberate — TRAA resolves aliasing in the post chain, and
 * MSAA on top of it would cost memory bandwidth for nothing.
 */
export async function initRenderer(
  containerSelector = '#app',
): Promise<RendererBundle> {
  const container = document.querySelector<HTMLElement>(containerSelector);
  if (!container) throw new Error(`Container ${containerSelector} not found`);

  // `?gputime=1` turns on GPU timestamp queries so a caller can read
  // `renderer.resolveTimestampsAsync('render' | 'compute')`. Off by default: the
  // queries themselves are not free, and reading them for a build that never asked
  // for them would answer a question nobody is measuring.
  const trackTimestamp =
    new URLSearchParams(window.location.search).get('gputime') === '1';

  // WebGPU or nothing. Three's renderer would quietly swap in its WebGL2 backend on a
  // browser without `navigator.gpu`, and every pass here is written against WebGPU
  // (storage buffers, compute, WGSL): the fallback does not run this pipeline, it
  // runs a different one and fails somewhere deep inside it.
  if (!('gpu' in navigator)) {
    throw new Error('WebGPU is not available in this browser; this application does not fall back to WebGL.');
  }
  const adapter = await navigator.gpu.requestAdapter();
  const adapterLimits = {
    maxStorageBufferBindingSize: adapter?.limits.maxStorageBufferBindingSize ?? 134217728,
    maxBufferSize: adapter?.limits.maxBufferSize ?? 268435456,
  };
  const renderer = new THREE.WebGPURenderer({
    antialias: false,
    forceWebGL: false,
    trackTimestamp,
    // The surfel GI passes need more than the WebGPU defaults: the integrator binds
    // 14 storage buffers in one compute stage, and the grid build dispatches
    // 512-wide workgroups. Without these the pipelines fail to create and every
    // compute pass silently drops.
    //
    // 14 rather than 10 because tracing movable geometry means a second acceleration
    // structure bound alongside the first — node/position/index/attribute again. WGSL
    // cannot take a storage binding as a function argument, so there is no way to
    // reuse one set of bindings for two structures; the count is the price of the
    // static/dynamic split.
    /* @important The storage limits are asked for too, and this is what the tracer's
       triangle budget rests on. WebGPU's default is 128 MiB per binding whatever the card
       can do - this one reports 2 GiB - and at 108 bytes a triangle that default caps the
       static BVH at 414252 triangles. Everything past the cap was replaced by cluster proxy
       boxes, and a surfel seeded on a replaced surface sits inside its own box and bakes a
       hole. Asking for the adapter's own maximum is what makes the budget a decision instead
       of an accident; where the hardware really offers 128 MiB, the budget follows it down. */
    requiredLimits: {
      maxStorageBuffersPerShaderStage: 14,
      maxComputeWorkgroupSizeX: 1024,
      maxComputeInvocationsPerWorkgroup: 1024,
      maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
      maxBufferSize: adapterLimits.maxBufferSize,
    },
  });

  // The pass viewer. Every intermediate buffer registers here via `.toInspector()`,
  // which is how we obey the Prime Law without guessing. `?inspector=0` detaches it —
  // it records the last 512 frames and their per-pass stats, which is a suspect
  // whenever the frame stalls periodically for no work.
  if (new URLSearchParams(window.location.search).get('inspector') !== '0') {
    renderer.inspector = new Inspector();
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Neutral, matching webgiya, so the GI port can be compared against its reference
  // frame-for-frame. AgX is the eventual target (CLAUDE.md §3) but swapping the
  // transfer function while porting would make every difference ambiguous.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  container.appendChild(renderer.domElement);
  await renderer.init();

  return { renderer, container };
}
