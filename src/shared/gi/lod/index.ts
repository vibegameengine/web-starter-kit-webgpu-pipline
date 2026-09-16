import * as THREE from 'three/webgpu';
import type { LightmapLayout } from '../bake/lightmapUv.ts';
import { applyLightmap } from '../bake/applyLightmap.ts';
import { PagePool } from './pagePool.ts';
import { WorkingAtlas } from './workingAtlas.ts';
import { planAtlas, type DemandPlan } from './demand.ts';
import { DemandFeedback } from './feedback.ts';
import { Layer } from '../../world/index.ts';

export { PagePool } from './pagePool.ts';
export { WorkingAtlas } from './workingAtlas.ts';
export { planAtlas } from './demand.ts';
export { DemandFeedback } from './feedback.ts';

export interface LodSettings {
  pageSize: number;
  atlasSize: number;
  copyBudget: number;
  feedbackSpacing: number;
}

export class LightmapLod {
  readonly pool: PagePool;
  readonly atlas: WorkingAtlas;
  readonly feedback: DemandFeedback;
  plan: DemandPlan = { demands: [], visible: 0, wantedCells: 0, grantedCells: 0, coarsened: 0, rootOnly: 0 };

  constructor(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    layout: LightmapLayout,
    pixels: Float32Array,
    intensity: ReturnType<typeof import('three/tsl').uniform>,
    private readonly settings: LodSettings,
  ) {
    this.pool = new PagePool(renderer, pixels, layout.atlasSize, layout.regions, settings.pageSize);
    this.atlas = new WorkingAtlas(renderer, this.pool, layout.regions.map(toOrigin), { width: layout.atlasSize, height: layout.atlasHeight }, settings.atlasSize);
    this.feedback = new DemandFeedback(renderer, scene, layout.regions.length, { width: layout.atlasSize, height: layout.atlasHeight }, settings.feedbackSpacing);
    applyLightmap(scene, this.atlas.texture, intensity, this.atlas.sampler());
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry.getAttribute('lightmapChart') && mesh.layers.isEnabled(Layer.GiStatic)) mesh.layers.enable(Layer.LightmapDemand);
    });
    console.log(
      `[lod] ${layout.regions.length} charts in ${this.pool.pages.length} source page(s) of ${settings.pageSize}² ` +
        `(${(this.pool.bytes / 1048576).toFixed(1)} MiB), working atlas ${settings.atlasSize}² ` +
        `(${((settings.atlasSize * settings.atlasSize * 8) / 1048576).toFixed(1)} MiB)`,
    );
  }

  update(camera: THREE.Camera, viewport: { width: number; height: number }): void {
    this.atlas.beginFrame();
    this.feedback.resize(viewport.width, viewport.height);
    this.feedback.render(camera);
    this.plan = planAtlas(this.feedback, {
      lastMip: (chart) => this.pool.lastMip(chart),
      sizeOf: (chart, mip) => this.pool.slice(chart, mip),
      capacityCells: this.atlas.plannableCells(),
    });
    this.atlas.serve(this.plan.demands, this.settings.copyBudget);
  }

  dispose(): void {
    this.feedback.dispose();
    this.pool.dispose();
    this.atlas.dispose();
  }
}

function toOrigin(region: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
  return { x: region.x, y: region.y, width: region.width, height: region.height };
}
