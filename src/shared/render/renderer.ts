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

  const renderer = new THREE.WebGPURenderer({
    antialias: false,
    forceWebGL: false,
    // The surfel GI passes need more than the WebGPU defaults: the integrator binds
    // 10 storage buffers in one compute stage, and the grid build dispatches
    // 512-wide workgroups. Without these the pipelines fail to create and every
    // compute pass silently drops.
    requiredLimits: {
      maxStorageBuffersPerShaderStage: 10,
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
