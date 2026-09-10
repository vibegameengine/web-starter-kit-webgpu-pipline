import type * as THREE from 'three/webgpu';
import type GUI from 'lil-gui';
import type { VolumetricFogSettings } from '../../shared/render/index.ts';
import type { ContactOcclusionSettings } from '../../shared/gi/contact/contactOcclusionPass.ts';
import type { ReflectionSettings } from '../../shared/gi/reflect/reflectionPass.ts';
import type { MotionBlurSettings } from '../../shared/render/motionBlur.ts';
import type { SurfelGI } from '../../shared/gi/index.ts';

export interface SceneHost {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: { update(): void; target: THREE.Vector3 };
  sun: THREE.DirectionalLight;
  update?: (elapsedSeconds: number) => void;
  bindGui?: (gui: GUI) => void;
  skyIsBackground: boolean;
  moverByDefault: boolean;
  sunIntensity?: number | 'environment';
  bindScreen?: (color: THREE.Texture, depth: THREE.Texture, normal: THREE.Texture) => void;
  atmosphere?: Partial<VolumetricFogSettings>;
  glare?: { strength: number; radius: number };
  contact?: Partial<ContactOcclusionSettings>;
  staticLighting?: boolean;
  reflections?: Partial<ReflectionSettings>;
  motionBlur?: Partial<MotionBlurSettings>;
  interiorVolumes?: THREE.Box3[];
}

export interface PipelineUi {
  setLoading(message: string): void;
  clearLoading(): void;
  showError(error: unknown): void;
  showChrome: boolean;
  applySavedSettings?(gui: GUI): void;
}

export interface RenderPipeline {
  gi: SurfelGI;
  envTexture: THREE.Texture;
  run(host: SceneHost, gui: GUI, ui: PipelineUi): Promise<void>;
}

export interface UrlParams {
  params: URLSearchParams;
  get(key: string): string | null;
  num(key: string): number | null;
  flag(key: string, fallback: boolean): boolean;
}

export function readUrlParams(): UrlParams {
  const params = new URLSearchParams(window.location.search);
  return {
    params,
    get: (key) => params.get(key),
    num(key) {
      const raw = params.get(key);
      if (raw === null) return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    },
    flag(key, fallback) {
      const raw = params.get(key);
      return raw === null ? fallback : raw !== '0';
    },
  };
}

export function hook(name: string, value: unknown): void {
  (window as unknown as Record<string, unknown>)[name] = value;
}
