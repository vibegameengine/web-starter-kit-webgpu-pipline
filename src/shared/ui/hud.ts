import type { CacheStats, WorldState } from '../world/index.ts';

interface Row {
  el: HTMLSpanElement;
  read: () => string;
}

/**
 * Minimal diagnostic overlay.
 *
 * The load-bearing row is `shadow rebuilds/s`. Epic's stated health metric for
 * Virtual Shadow Maps is that invalidated static pages sit at ~0; this is the same
 * number for our cache. It reads 0 in Phase 0 because the split does not exist yet —
 * it is on screen from day one precisely so that Phase 1 has something to prove.
 */
export class Hud {
  private readonly rows: Row[] = [];
  private readonly root: HTMLDivElement;
  private frames = 0;
  private accum = 0;
  private fps = 0;

  constructor(
    private readonly world: WorldState,
    private readonly stats: CacheStats,
    /** Reports whether the GI cache is frozen — the headline state of a baked build. */
    private readonly giFrozen: () => string = () => 'converging',
    private readonly bakedLight: (() => string) | null = null,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.dataset.testid = 'hud';
    document.body.appendChild(this.root);

    this.addRow('fps', () => this.fps.toFixed(0));
    this.addRow('gi cache', () => this.giFrozen());
    if (this.bakedLight) this.addRow('baked light', () => this.bakedLight!());
    this.addRow('sun', () => {
      const { azimuthDeg, elevationDeg } = this.world.sun;
      return `${azimuthDeg.toFixed(2)}° / ${elevationDeg.toFixed(2)}°`;
    });
    this.addRow('sun version', () => String(this.world.sunVersion));
    this.addRow('static geo version', () => String(this.world.staticGeoVersion));
    this.addRow('shadow rebuilds/s', () =>
      this.stats.staticShadowRebuildsPerSec.toFixed(1),
    );
    this.addRow('gi bricks/s', () => this.stats.giBricksPerSec.toFixed(0));
  }

  private addRow(label: string, read: () => string): void {
    const row = document.createElement('div');
    row.className = 'hud-row';

    const key = document.createElement('span');
    key.className = 'hud-key';
    key.textContent = label;

    const value = document.createElement('span');
    value.className = 'hud-value';
    value.dataset.testid = `hud-${label.replace(/[^a-z]+/gi, '-').toLowerCase()}`;

    row.append(key, value);
    this.root.appendChild(row);
    this.rows.push({ el: value, read });
  }

  update(dt: number): void {
    this.frames++;
    this.accum += dt;
    if (this.accum >= 0.5) {
      this.fps = this.frames / this.accum;
      this.frames = 0;
      this.accum = 0;
    }
    for (const row of this.rows) row.el.textContent = row.read();
  }
}
