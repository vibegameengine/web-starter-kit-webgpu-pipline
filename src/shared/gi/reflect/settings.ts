import type * as THREE from 'three/webgpu';
import { reflectKnobs } from './knobs.ts';

export interface ReflectSettings {
  enabled: boolean;
  /**
   * Above this roughness a pixel is the diffuse tier's problem, not this one's. It is
   * also what keeps the default scene out of this tier entirely — see `knobs.ts`.
   */
  roughnessCutoff: number;
  /** Metres of ray budget before a hit falls back to the world-space cache. */
  range: number;
  temporalAlpha: number;
  spatialFilter: boolean;
  resolutionDivisor: number;
  /** Inject the glossy Cornell variant. See `knobs.ts` for why it is opt-in. */
  testScene: boolean;
  testRoughness: number;
  /** 0 is the shipping path; anything else swaps the output for a factor of it. */
  debugMode: number;
  /** Hand the composite `1 - metalness` rather than a flat 1. See `knobs.ts`. */
  killMetalDiffuse: boolean;
}

export const reflectSettings: ReflectSettings = {
  enabled: reflectKnobs.enabled(),
  roughnessCutoff: reflectKnobs.roughnessCutoff(),
  range: reflectKnobs.range(),
  temporalAlpha: reflectKnobs.temporalAlpha(),
  spatialFilter: reflectKnobs.spatialFilter(),
  resolutionDivisor: reflectKnobs.resolutionDivisor(),
  testScene: reflectKnobs.testScene(),
  testRoughness: reflectKnobs.testRoughness(),
  debugMode: reflectKnobs.debugMode(),
  killMetalDiffuse: reflectKnobs.killMetalDiffuse(),
};

export function applyReflectSettings(next: Partial<ReflectSettings>): void {
  Object.assign(reflectSettings, next);
}

/**
 * The specular gather's output, published rather than returned.
 *
 * The composite in `render/frameGraph.ts` has to find this, and the pass that writes it
 * is built deep inside the GI chain — the one place that can see both is `app/main.ts`,
 * which this work is not allowed to add a wiring call to. `probe/settings.ts` publishes
 * `probeTextures` for the identical reason and this follows it rather than inventing a
 * second convention. The dependency direction stays acyclic: `render` reads `gi`, `gi`
 * never reads `render`.
 */
export const reflectTextures: {
  /** Half-res specular radiance, already weighted by F and the GGX visibility term. */
  reflection: THREE.Texture | null;
} = {
  reflection: null,
};

/** Sized once per resize; read by the report and by anything drawing the pane. */
export const reflectStats = {
  width: 0,
  height: 0,
  /** True once the trace has actually dispatched at least once. */
  ran: false,
};
