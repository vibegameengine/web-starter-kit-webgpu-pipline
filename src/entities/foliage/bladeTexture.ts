import * as THREE from 'three/webgpu';

/**
 * Draws an alpha-cut foliage card procedurally rather than shipping another asset.
 *
 * The alpha channel is the point. Alpha-tested foliage is the single largest category
 * of geometry a forest contains, and it is also the category a triangle ray tracer
 * cannot handle without evaluating the material at the hit — which the surfel
 * integrator does not do. A scene meant to expose that has to actually contain cutout
 * cards, not opaque stand-ins that quietly trace correctly.
 */
export function createBladeTexture(
  kind: 'grass' | 'fern',
  size = 256,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('createBladeTexture: no 2d context');

  ctx.clearRect(0, 0, size, size);

  const blade = (
    cx: number,
    halfWidth: number,
    tint: string,
    lean: number,
  ): void => {
    ctx.fillStyle = tint;
    ctx.beginPath();
    ctx.moveTo(cx - halfWidth, size);
    ctx.quadraticCurveTo(cx - halfWidth * 0.6 + lean, size * 0.4, cx + lean, 0);
    ctx.quadraticCurveTo(cx + halfWidth * 0.6 + lean, size * 0.4, cx + halfWidth, size);
    ctx.closePath();
    ctx.fill();
  };

  if (kind === 'grass') {
    blade(size * 0.28, size * 0.05, '#4f6f2e', -size * 0.06);
    blade(size * 0.5, size * 0.06, '#5f8438', 0);
    blade(size * 0.72, size * 0.045, '#425f27', size * 0.07);
  } else {
    // A frond: a midrib with leaflets, so the cutout has interior holes and the
    // silhouette is not a convex blob the tracer could approximate away.
    ctx.fillStyle = '#3d5c2a';
    ctx.fillRect(size * 0.47, size * 0.05, size * 0.06, size * 0.9);
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const y = size * (0.08 + t * 0.82);
      const span = size * 0.42 * (1 - t * 0.75);
      ctx.fillStyle = i % 2 === 0 ? '#466830' : '#3a5726';
      ctx.beginPath();
      ctx.ellipse(size * 0.5 - span * 0.5, y, span * 0.5, size * 0.035, -0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(size * 0.5 + span * 0.5, y, span * 0.5, size * 0.035, 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
