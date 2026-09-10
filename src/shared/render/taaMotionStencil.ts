import type * as THREE from 'three/webgpu';
import { Fn, If, clamp, float, ivec2, mix, textureLoad, uniform, vec2 } from 'three/tsl';

type N = ReturnType<typeof float>;
type TextureNode = { value: THREE.Texture };

const STENCIL_RADIUS = 2;

export interface MotionStencilInputs {
  motion: TextureNode;
  previousMotion: TextureNode;
  px: N;
  maxPx: N;
  prevUv: N;
  size: N;
}

export class MotionStencil {
  active = true;
  readonly pixels = uniform(1);
  readonly weight = uniform(0.25);
  readonly clipScale = uniform(0.5);

  mark({ motion, previousMotion, px, maxPx, prevUv, size }: MotionStencilInputs): N {
    const speed = (ndcDelta: N) => vec2(ndcDelta.x.mul(0.5), ndcDelta.y.mul(-0.5)).mul(size).length();
    return Fn(() => {
      const marked = float(0).toVar();
      for (let y = -STENCIL_RADIUS; y <= STENCIL_RADIUS; y++) for (let x = -STENCIL_RADIUS; x <= STENCIL_RADIUS; x++) {
        const p = clamp(px.add(ivec2(x, y)), ivec2(0), maxPx);
        If(speed(textureLoad(motion.value, p).xy).greaterThan(this.pixels), () => marked.assign(1));
      }
      const prevPx = clamp(ivec2(prevUv.mul(size)), ivec2(0), maxPx);
      If(speed(textureLoad(previousMotion.value, prevPx).xy).greaterThan(this.pixels), () => marked.assign(1));
      return marked;
    })();
  }

  historyWeight(weight: N, marked: N): N {
    return mix(weight, weight.min(this.weight), marked);
  }

  clipExtent(extent: N, marked: N): N {
    return extent.mul(mix(float(1), this.clipScale, marked));
  }
}
