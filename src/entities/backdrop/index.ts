import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  color,
  float,
  mix,
  mrt,
  mx_noise_float,
  positionWorld,
  select,
  smoothstep,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

export interface BackdropOptions {
  /** Where the island's underside is; the contact shadow floats a little below it. */
  islandBottom: number;
  islandHalf: number;
}

/**
 * Studio cyclorama: a warm neutral gradient that the diorama floats in front of, and a
 * soft dark pool of shadow under it. Unlit on purpose — it is a photograph backdrop,
 * not a wall that bounces light — so it is excluded from every GI structure and
 * written to no G-buffer attachment; it shows up in the beauty pass and nowhere else.
 *
 * The shadow pool is computed inside the dome shader: the dome pixel's view ray is
 * intersected with an invisible floor plane under the island, and the backdrop is
 * darkened by distance from the island's footprint on that plane. No second surface,
 * no blending, no sorting.
 */
export function createBackdrop(options: BackdropOptions): THREE.Group {
  const group = new THREE.Group();
  group.name = 'backdrop';

  const domeMaterial = new THREE.MeshBasicNodeMaterial();
  domeMaterial.name = 'backdropDome';
  domeMaterial.side = THREE.BackSide;
  domeMaterial.fog = false;

  const dir = positionWorld.normalize();
  // Lighter and warmer toward the upper left (the key light side), cooler and darker
  // toward the lower right, with a barely-there grain so the gradient never bands.
  const upness = smoothstep(-0.7, 0.9, dir.y);
  const sideness = smoothstep(-1.0, 1.0, dir.x.negate().mul(0.6).add(dir.z.mul(0.3)));
  const light = color(0.80, 0.745, 0.69);
  const dark = color(0.30, 0.275, 0.255);
  const grade = mix(dark, light, upness.mul(0.75).add(sideness.mul(0.25)));
  const grain = mx_noise_float(positionWorld.mul(0.35)).mul(0.012);

  // Contact shadow on an implicit floor plane below the slab.
  const floorY = float(options.islandBottom - 1.4);
  const ray = positionWorld.sub(cameraPosition).normalize();
  const t = floorY.sub(cameraPosition.y).div(ray.y);
  const hit = cameraPosition.xz.add(ray.xz.mul(t));
  const centre = vec2(0.9, 0.7);
  const radial = hit.sub(centre).div(options.islandHalf * 1.5).length();
  const pool = float(1.0).sub(smoothstep(0.25, 1.0, radial));
  const valid = ray.y.lessThan(-0.02).and(t.greaterThan(0.0));
  const shadow = select(valid, pool.mul(pool).mul(0.75), float(0.0));

  domeMaterial.colorNode = grade.add(vec3(grain)).mul(float(1.0).sub(shadow));
  domeMaterial.mrtNode = mrt({ albedo: vec4(0.0), normal: vec4(0.0, 0.0, 1.0, 0.0), velocity: vec4(0.0, 0.0, 0.0, 1.0) });

  const dome = new THREE.Mesh(new THREE.SphereGeometry(160, 48, 32), domeMaterial);
  dome.name = 'backdropDome';
  dome.userData.giExclude = true;
  dome.castShadow = false;
  dome.receiveShadow = false;
  dome.frustumCulled = false;
  group.add(dome);
  return group;
}
