import { wgslFn } from 'three/tsl';

// Singular axes of the UV Jacobian. The minor eigenvalue uses det / major
// to avoid cancellation on grazing surfaces. XY = major axis in base texels,
// Z = filtered minor width, W = bounded line tap count.
export const virtualFootprint = wgslFn(`fn virtualFootprint(dx: vec2f, dy: vec2f, maxAnisotropy: f32) -> vec4f {
  let a = dx.x * dx.x + dy.x * dy.x;
  let b = dx.x * dx.y + dy.x * dy.y;
  let c = dx.y * dx.y + dy.y * dy.y;
  let major2 = max(0.5 * (a + c + sqrt(max(0.0, (a - c) * (a - c) + 4.0 * b * b))), 1e-12);
  let determinant = dx.x * dy.y - dx.y * dy.x;
  let minor2 = max(0.0, determinant * determinant / major2);
  let major = sqrt(major2);
  let width = max(1.0, max(sqrt(minor2), major / clamp(maxAnisotropy, 1.0, 8.0)));
  var axis = vec2f(b, major2 - a);
  let other = vec2f(major2 - c, b);
  if (dot(other, other) > dot(axis, axis)) { axis = other; }
  axis /= max(length(axis), 1e-12);
  let span = sqrt(max(0.0, major2 - width * width));
  return vec4f(axis * span, width, clamp(ceil(major / width), 1.0, 8.0));
}`);

/** Same width convention for coarse CPU page demand; derivatives are in base texels. */
export function footprintWidth(dx: [number, number], dy: [number, number], anisotropy: number): number {
  const a = dx[0] ** 2 + dy[0] ** 2, b = dx[0] * dx[1] + dy[0] * dy[1], c = dx[1] ** 2 + dy[1] ** 2;
  const major2 = Math.max(.5 * (a + c + Math.sqrt(Math.max(0, (a - c) ** 2 + 4 * b * b))), 1e-12);
  const det = dx[0] * dy[1] - dx[1] * dy[0];
  return Math.max(1, Math.sqrt(det * det / major2), Math.sqrt(major2) / Math.max(1, Math.min(8, anisotropy)));
}
