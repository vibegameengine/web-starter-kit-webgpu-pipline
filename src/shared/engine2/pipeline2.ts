import * as THREE from 'three/webgpu';
import {
  pass,
  mrt,
  output,
  velocity,
  normalView,
  float,
  vec3,
  vec4,
  uniform,
  Fn,
  uv,
  Loop,
  int,
  smoothstep,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { film } from 'three/addons/tsl/display/FilmNode.js';
import { hashBlur } from 'three/addons/tsl/display/hashBlur.js';

/**
 * @deprecated WRONG PATH. Product pipeline = vendor/webgiya (jure/webgiya).
 * See docs/PIPELINE.md. This file is only for npm run dev:legacy.
 */
/** Debug views — switch like Three.js example pass inspectors. */
export const PASS_MODES = {
  Final: 'final',
  Beauty: 'beauty',
  Depth: 'depth',
  Normal: 'normal',
  AO: 'ao',
  GI: 'gi',
  'Direct×AO': 'direct_ao',
  GodRays: 'godrays',
} as const;

export type PassMode = (typeof PASS_MODES)[keyof typeof PASS_MODES];

/**
 * Pipeline + pass debugger.
 * Build all intermediate buffers once; setPassMode() swaps post.outputNode.
 */
export class Pipeline2 {
  readonly renderer: THREE.WebGPURenderer;
  readonly post: THREE.PostProcessing;
  readonly sunScreen = uniform(new THREE.Vector2(0.5, 0.35));
  readonly godRayIntensity = uniform(0.22);
  readonly giStrength = uniform(0.4);
  readonly aoPower = uniform(1.15);

  private nodes: Record<string, unknown> = {};
  private mode: PassMode = PASS_MODES.Final;

  private constructor(renderer: THREE.WebGPURenderer, post: THREE.PostProcessing) {
    this.renderer = renderer;
    this.post = post;
  }

  static async create(
    container: HTMLElement,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ): Promise<Pipeline2> {
    const renderer = new THREE.WebGPURenderer({ antialias: false });
    await renderer.init();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.VSMShadowMap;
    container.appendChild(renderer.domElement);

    const post = new THREE.PostProcessing(renderer);
    const pipe = new Pipeline2(renderer, post);

    const scenePass = pass(scene, camera);
    scenePass.setMRT(
      mrt({
        output,
        normal: normalView,
        velocity,
      }),
    );

    const beauty = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const normal = scenePass.getTextureNode('normal');
    const linearDepth = scenePass.getLinearDepthNode();
    void velocity;

    const aoPass = ao(depth, normal, camera);
    aoPass.resolutionScale = 0.5;
    aoPass.radius.value = 0.55;
    aoPass.thickness.value = 2.0;
    aoPass.scale.value = 1.15;
    const aoTex = aoPass.getTextureNode();

    const irradiance = hashBlur(beauty, float(0.03), { repeats: float(12) });
    const aoF = aoTex.r.mul(pipe.aoPower).clamp(0.0, 1.0);
    const directAo = beauty.rgb.mul(aoF.mul(0.9).add(0.1));
    const giOnly = irradiance.rgb.mul(pipe.giStrength);
    const lit = directAo.add(giOnly.mul(aoF.oneMinus().mul(0.5).add(0.4)));

    const withRays = Fn(() => {
      const uvc = uv().toVar();
      const base = lit.toVar();
      const dir = pipe.sunScreen.sub(uvc).toVar();
      const stepV = dir.div(float(24.0)).toVar();
      const illum = float(0.0).toVar();
      const fall = float(1.0).toVar();
      Loop(int(24), () => {
        uvc.addAssign(stepV);
        const col = beauty.sample(uvc).rgb;
        const lum = col.dot(vec3(0.3, 0.5, 0.2));
        const bri = smoothstep(float(1.15), float(2.4), lum);
        illum.addAssign(bri.mul(fall).mul(float(0.1)));
        fall.mulAssign(float(0.94));
      });
      return base.add(vec3(1.05, 0.96, 0.8).mul(illum).mul(pipe.godRayIntensity));
    })();

    // --- debug visualizations ---
    // getLinearDepthNode() is already a per-pixel float (not a texture)
    const depthVis = vec4(
      vec3(float(1.0).sub(smoothstep(float(0.0), float(1.0), linearDepth))),
      1.0,
    );

    const normalVis = Fn(() => {
      const n = normal.sample(uv()).rgb.mul(0.5).add(0.5);
      return vec4(n, 1.0);
    })();

    const aoVis = Fn(() => {
      const a = aoTex.sample(uv()).r;
      return vec4(vec3(a), 1.0);
    })();

    const giVis = Fn(() => vec4(giOnly, 1.0))();
    const beautyVis = Fn(() => vec4(beauty.sample(uv()).rgb, 1.0))();
    const directVis = Fn(() => vec4(directAo, 1.0))();
    const raysVis = Fn(() => vec4(withRays, 1.0))();

    const finalStack = (() => {
      const aa = smaa(vec4(withRays, 1.0) as never);
      const glow = bloom(aa as never, 0.28, 0.5, 0.92);
      const bloomed = (aa as { add: (n: unknown) => unknown }).add(glow);
      return film(bloomed as never, float(0.05));
    })();

    pipe.nodes = {
      [PASS_MODES.Final]: finalStack,
      [PASS_MODES.Beauty]: beautyVis,
      [PASS_MODES.Depth]: depthVis,
      [PASS_MODES.Normal]: normalVis,
      [PASS_MODES.AO]: aoVis,
      [PASS_MODES.GI]: giVis,
      [PASS_MODES['Direct×AO']]: directVis,
      [PASS_MODES.GodRays]: raysVis,
    };

    pipe.applyMode(PASS_MODES.Final);

    window.addEventListener('resize', () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    });

    return pipe;
  }

  private applyMode(mode: PassMode): void {
    this.mode = mode;
    const node = this.nodes[mode] ?? this.nodes[PASS_MODES.Final];
    this.post.outputNode = node as never;
    this.post.needsUpdate = true;
  }

  setPassMode(mode: PassMode | string): void {
    const valid = Object.values(PASS_MODES) as string[];
    this.applyMode((valid.includes(mode) ? mode : PASS_MODES.Final) as PassMode);
  }

  getPassMode(): PassMode {
    return this.mode;
  }

  setExposure(ev: number): void {
    this.renderer.toneMappingExposure = Math.pow(2, ev);
  }

  setSunScreen(u: number, v: number): void {
    this.sunScreen.value.set(u, v);
  }

  setGodRayIntensity(v: number): void {
    this.godRayIntensity.value = v;
  }

  setGiStrength(v: number): void {
    this.giStrength.value = v;
  }

  render(): void {
    this.post.render();
  }
}
