import * as THREE from 'three/webgpu';

/**
 * How strong the analytic sun has to be for the scene to agree with its panorama.
 *
 * The GI reads the environment through a luminance knee (`sampleEnvEquirectClamped`
 * in surfelIntegratePass.ts: untouched below 5, compressed toward 15) so that the
 * sun disc in the HDR does not light the scene twice. Whatever that knee removes
 * is exactly the energy the directional light must carry: integrating the clipped
 * radiance over the sphere gives the sun's irradiance on a plane facing it, which
 * is a `DirectionalLight.intensity` in this renderer's units. For
 * pizzo_pernice_puresky_2k that is ≈ 4.7 (the HDR loaded as half float; ≈ 5.3
 * as float — the file's sun peak is clipped by the format) against a sky
 * irradiance of ≈ 0.7 from above — a clear-day ratio, where the authored
 * default of 2 was not.
 */
export function sunIntensityFromEnvironment(texture: THREE.Texture, knee = 5, maxVal = 15): number {
  const image = texture.image as { data?: ArrayLike<number>; width: number; height: number };
  if (!image?.data) return 2;
  const half = texture.type === THREE.HalfFloatType;
  const { data, width, height } = image;
  const read = (i: number): number => (half ? THREE.DataUtils.fromHalfFloat(data[i] as number) : (data[i] as number));
  let clipped = 0;
  for (let y = 0; y < height; y++) {
    const sinTheta = Math.sin(((y + 0.5) / height) * Math.PI);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const lum = 0.2126 * read(i) + 0.7152 * read(i + 1) + 0.0722 * read(i + 2);
      if (lum <= knee) continue;
      const compressed = knee + (maxVal - knee) * (1 - Math.exp(-(lum - knee) / (maxVal - knee)));
      clipped += (lum - compressed) * sinTheta;
    }
  }
  // dΩ = sinθ dθ dφ with dθ = π/height, dφ = 2π/width.
  return clipped * ((2 * Math.PI * Math.PI) / (width * height));
}
