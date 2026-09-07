/**
 * Fills unlit texels inside a lit chart from their neighbours.
 *
 * A texel whose surfel was seeded inside another object — sand under a boulder's
 * footprint — sees geometry in every direction and integrates to black. It is not a
 * shadow: nothing in the world is that dark next to sunlit sand, and once the page
 * filter reaches it the black bleeds a texel or two into the sand around the rock.
 * The reference frame has no such contact; the critic measured a 70:1 step where the
 * reference has 2.2:1.
 *
 * The fix is a dilation with a threshold: a covered texel far below the brightest
 * texel around it is treated as invalid and replaced by the mean of its lit
 * neighbours. Genuine crevices survive because they are dim relative to their
 * neighbourhood only by a factor of a few, not by fifty.
 *
 * Runs on the CPU pixels once, before the lightmap is published or saved, so the
 * pages, the fallback and the bundle all carry the filled texels.
 */
export function dilateUnlitTexels(
  pixels: Float32Array,
  size: number,
  options: { radius?: number; ratio?: number; passes?: number } = {},
): number {
  const { radius = 2, ratio = 0.03, passes = 2 } = options;
  let filled = 0;
  const luma = (i: number) =>
    0.2126 * pixels[i * 4] + 0.7152 * pixels[i * 4 + 1] + 0.0722 * pixels[i * 4 + 2];

  for (let pass = 0; pass < passes; pass++) {
    const source = pixels.slice();
    const sourceLuma = (i: number) =>
      0.2126 * source[i * 4] + 0.7152 * source[i * 4 + 1] + 0.0722 * source[i * 4 + 2];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const own = luma(i);
        let maxNeighbour = 0;
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let lit = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= size) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= size || (dx === 0 && dy === 0)) continue;
            const j = ny * size + nx;
            const l = sourceLuma(j);
            if (l > maxNeighbour) maxNeighbour = l;
            if (l > 1e-4) {
              sumR += source[j * 4];
              sumG += source[j * 4 + 1];
              sumB += source[j * 4 + 2];
              lit++;
            }
          }
        }
        // Empty atlas space stays empty: it only counts when lit texels surround it.
        if (lit < 3 || maxNeighbour <= 1e-4) continue;
        if (own >= maxNeighbour * ratio) continue;
        pixels[i * 4] = sumR / lit;
        pixels[i * 4 + 1] = sumG / lit;
        pixels[i * 4 + 2] = sumB / lit;
        filled++;
      }
    }
  }
  return filled;
}
