import * as THREE from 'three/webgpu';
import type { uniform } from 'three/tsl';
import type { LightmapLayout } from '../bake/lightmapUv.ts';
import { applyLightmap } from '../bake/applyLightmap.ts';
import { Layer } from '../../world/index.ts';
import { ChartPyramidSet } from './chartPyramids.ts';
import { DemandFeedback } from './feedback.ts';
import { TilePool } from './tilePool.ts';

export { ChartPyramidSet } from './chartPyramids.ts';
export { TileResidency } from './tileResidency.ts';
export { TilePool } from './tilePool.ts';
export { DemandFeedback } from './feedback.ts';

export interface LodSettings {
  tileSize: number;
  slotsPerSide: number;
  copyBudget: number;
  feedbackSpacing: number;
  shiftSlots: boolean;
  evictAll: boolean;
}

export class LightmapLod {
  readonly pyramids: ChartPyramidSet;
  readonly pool: TilePool;
  readonly feedback: DemandFeedback;

  constructor(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    layout: LightmapLayout,
    pixels: Float32Array,
    intensity: ReturnType<typeof uniform>,
    settings: LodSettings,
  ) {
    const started = performance.now();
    const sourceAtlas = { width: layout.atlasSize, height: layout.atlasHeight };
    this.pyramids = new ChartPyramidSet({ atlas: pixels, atlasWidth: layout.atlasSize, regions: layout.regions, tileSize: settings.tileSize });
    this.pool = new TilePool(renderer, this.pyramids, sourceAtlas, settings);
    this.feedback = new DemandFeedback(renderer, scene, sourceAtlas, settings.feedbackSpacing,
      (chart, level, atlasX, atlasY) => this.pyramids.tileAt(chart, level, atlasX, atlasY));
    applyLightmap(scene, this.pool.texture, intensity, this.pool.sampler());
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry.getAttribute('lightmapChart') && mesh.layers.isEnabled(Layer.GiStatic)) mesh.layers.enable(Layer.LightmapDemand);
    });
    console.log(
      `[lod] ${layout.regions.length} charts, ${this.pyramids.tiles.length} tiles of ${settings.tileSize}² in ${this.pyramids.storePages.length} store page(s), ` +
        `tail ${this.pyramids.tailSize}², pool ${this.pool.residency.capacity} slots (${this.pool.size}²), ` +
        `${(this.pool.storeBytes / 1048576).toFixed(1)} MiB stored, built in ${(performance.now() - started).toFixed(0)} ms`,
    );
  }

  update(camera: THREE.Camera, viewport: { width: number; height: number }): void {
    this.feedback.resize(viewport.width, viewport.height);
    this.feedback.render(camera);
    this.pool.serve(this.feedback.requests);
  }

  dispose(): void {
    this.feedback.dispose();
    this.pool.dispose();
  }
}
