import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass,
  BloomEffect, SMAAEffect, SMAAPreset,
  ToneMappingEffect, ToneMappingMode,
  VignetteEffect, HueSaturationEffect, BrightnessContrastEffect,
  KernelSize,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { Effect } from 'postprocessing';

/** Pre-tonemap exposure (UE: eye adaptation locked to a fixed EV). */
class ExposureEffect extends Effect {
  constructor(exposure = 1) {
    super(
      'ExposureEffect',
      'uniform float uExposure; void mainImage(const in vec4 c, const in vec2 uv, out vec4 o){ o = vec4(c.rgb * uExposure, c.a); }',
      { uniforms: new Map([['uExposure', new THREE.Uniform(exposure)]]) },
    );
  }
  set exposure(v: number) {
    this.uniforms.get('uExposure')!.value = v;
  }
}

/**
 * UE-style render pipeline:
 * scene renders to a linear half-float HDR buffer, then
 * GTAO-class AO → soft bloom → ACES filmic tonemap (UE default) →
 * light grade → vignette → SMAA. Exposure lives on the tonemapper.
 */
export class Pipeline {
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  readonly bloom: BloomEffect;
  private exposureFx: ExposureEffect;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private n8ao: any;

  constructor(container: HTMLElement, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const renderer = new THREE.WebGLRenderer({
      antialias: false, // SMAA in post
      powerPreference: 'high-performance',
      stencil: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping; // tonemapped in post (linear workflow)
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap; // Poisson kernel from softShadows.ts
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
    composer.addPass(new RenderPass(scene, camera));

    // AO — contact shadowing (UE: GTAO)
    const n8ao = new N8AOPostPass(scene, camera, container.clientWidth, container.clientHeight);
    n8ao.configuration.aoRadius = 3.0;
    n8ao.configuration.distanceFalloff = 1.0;
    n8ao.configuration.intensity = 1.8;
    n8ao.configuration.halfRes = true;
    composer.addPass(n8ao);
    this.n8ao = n8ao;
    void this.n8ao;

    // Bloom — UE default is soft, wide, low intensity
    this.bloom = new BloomEffect({
      intensity: 0.35,
      luminanceThreshold: 1.0,
      luminanceSmoothing: 0.4,
      mipmapBlur: true,
      kernelSize: KernelSize.HUGE,
      radius: 0.85,
    });

    this.exposureFx = new ExposureEffect(1.0);
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    const grade = new HueSaturationEffect({ saturation: 0.08 });
    const contrast = new BrightnessContrastEffect({ contrast: 0.05 });
    const vignette = new VignetteEffect({ offset: 0.25, darkness: 0.16 });
    const smaa = new SMAAEffect({ preset: SMAAPreset.HIGH });

    composer.addPass(new EffectPass(camera, this.exposureFx, this.bloom, tone, grade, contrast, vignette, smaa));
    this.composer = composer;

    window.addEventListener('resize', () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
      composer.setSize(container.clientWidth, container.clientHeight);
    });
  }

  setExposure(ev: number): void {
    this.exposureFx.exposure = Math.pow(2, ev);
  }

  render(): void {
    this.composer.render();
  }
}
