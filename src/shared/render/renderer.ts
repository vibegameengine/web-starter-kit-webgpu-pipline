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
    requiredLimits: {
      maxStorageBuffersPerShaderStage: 14,
      maxComputeWorkgroupSizeX: 1024,
      maxComputeInvocationsPerWorkgroup: 1024,
    },
  });

  // The pass viewer. Every intermediate buffer registers here via `.toInspector()`,
  // which is how we obey the Prime Law without guessing.
  renderer.inspector = new Inspector();

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
