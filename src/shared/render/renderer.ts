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
  });

  // The pass viewer. Every intermediate buffer registers here via `.toInspector()`,
  // which is how we obey the Prime Law without guessing.
  renderer.inspector = new Inspector();

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  container.appendChild(renderer.domElement);
  await renderer.init();

  return { renderer, container };
}
