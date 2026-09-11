import { IslandField } from '../../entities/island/index.ts';
import { VILLAGE_TERRACES } from '../../entities/village/layout.ts';

export class VillageField extends IslandField {
  height(x: number, z: number): number {
    const shore = .7 + 1.1 * Math.exp(-(((x + 1.2) / 3.4) ** 2)) + .15 * Math.sin(x * .7);
    const t = Math.max(0, Math.min(1, (shore - z + 2.4) / 3.1));
    const blend = t * t * (3 - 2 * t);
    const bed = -1.3 - Math.max(0, z) * .2 + .3 * this.noise.fbm2(x * .32, z * .28, 3);
    let height = bed * (1 - blend) + (.22 + .025 * this.noise.noise2(x, z)) * blend;
    const rockyHeadland = Math.exp(-(((x + 7) / 2.7) ** 4)) * Math.max(0, Math.min(1, (-z + .2) / 4));
    height += 1.9 * rockyHeadland;
    for (const terrace of VILLAGE_TERRACES) {
      if (x >= terrace.x0 && x <= terrace.x1 && z >= terrace.z0 && z <= terrace.z1) height = Math.max(height, terrace.top - .2);
    }
    if(x< -9.25 && z< -2.65) {
      const along=Math.max(0,Math.min(1,(-z-2.65)/1.1));
      const across=Math.max(0,Math.min(1,(x+10)/.75));
      const shoulder=2.05+.65*across+.1*this.noise.noise2(z*.8,x);
      height=Math.max(height,shoulder*along+height*(1-along));
    }
    if (Math.abs(x+6.8)<.68 && z> -3.34 && z< -1.25) height=.29;
    return height;
  }
}
