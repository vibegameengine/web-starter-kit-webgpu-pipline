/* @important The independent reference design section 07 asks for, and the reason the rest of the
   acceptance is not enough on its own: a sealed box catches light that should not be there, but it
   cannot catch an answer that is uniformly wrong. This shares no code with the renderer - its own
   geometry, its own intersection, its own integrator - so agreement between the two is evidence and
   not a tautology. The quantity is the atlas's own: diffuse irradiance divided by pi, before the
   receiver's albedo, indirect only, which is what the bake stores and what the material multiplies
   by albedo at presentation. */

const EPSILON = 1e-12;

/* @important No default sun. The scene asks for one and setupSun overwrites both its direction and
   its intensity from the panorama's sun search, so any constant here would be a quiet lie - 22
   degrees and 6 against the renderer's 53.1 and 2.0, which is what put an earlier comparison at
   ratios 0.205 and 0.637. The caller reads the sun off the page and passes it. */
export const LEAK_ROOM = {
  inner: 2,
  wall: 0.2,
  height: 2,
  ground: 12,
  shellAlbedo: srgbToLinear(0x8f / 255),
  groundAlbedo: srgbToLinear(0x9a / 255),
};

function srgbToLinear(c) {
  return c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function box(min, max, albedo) {
  return { min, max, albedo };
}

export function leakRoomGeometry({ gap = 0, scale = 1 } = {}) {
  const { inner, wall, height, ground, shellAlbedo, groundAlbedo } = LEAK_ROOM;
  const s = scale;
  const half = (inner / 2 + wall / 2) * s;
  const outer = (inner + 2 * wall) * s;
  const thickness = wall * s;
  const tall = height * s;
  const lift = gap * s;
  return [
    box([-ground * s / 2, -0.001 * s, -ground * s / 2], [ground * s / 2, 0, ground * s / 2], groundAlbedo),
    box([-half - thickness / 2, 0, -outer / 2], [-half + thickness / 2, tall, outer / 2], shellAlbedo),
    box([-outer / 2, 0, -half - thickness / 2], [outer / 2, tall, -half + thickness / 2], shellAlbedo),
    box([-outer / 2, 0, half - thickness / 2], [outer / 2, tall, half + thickness / 2], shellAlbedo),
    box([-outer / 2, tall, -outer / 2], [outer / 2, tall + thickness, outer / 2], shellAlbedo),
    box([half - thickness / 2, lift, -outer / 2], [half + thickness / 2, lift + tall, outer / 2], shellAlbedo),
  ];
}



function nearestSlabHit(body, origin, direction, tMax) {
  let near = EPSILON;
  let far = tMax;
  let axis = 0;
  let facing = 1;
  for (let a = 0; a < 3; a++) {
    const inverse = 1 / (direction[a] === 0 ? EPSILON : direction[a]);
    let t0 = (body.min[a] - origin[a]) * inverse;
    let t1 = (body.max[a] - origin[a]) * inverse;
    let side = -1;
    if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; side = 1; }
    if (t0 > near) { near = t0; axis = a; facing = side; }
    if (t1 < far) far = t1;
    if (near > far) return null;
  }
  return { t: near, axis, facing };
}

export function intersect(bodies, origin, direction, tMax = Infinity) {
  let best = null;
  for (const body of bodies) {
    const hit = nearestSlabHit(body, origin, direction, tMax);
    if (!hit || (best && hit.t >= best.t)) continue;
    best = { ...hit, body };
  }
  if (!best) return null;
  const normal = [0, 0, 0];
  normal[best.axis] = best.facing;
  return {
    t: best.t,
    point: origin.map((v, i) => v + direction[i] * best.t),
    normal,
    albedo: best.body.albedo,
  };
}

function occluded(bodies, origin, direction, tMax) {
  return intersect(bodies, origin, direction, tMax) !== null;
}

function orthonormalBasis(normal) {
  const up = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const raw = [
    up[1] * normal[2] - up[2] * normal[1],
    up[2] * normal[0] - up[0] * normal[2],
    up[0] * normal[1] - up[1] * normal[0],
  ];
  const length = Math.hypot(...raw);
  const tangent = raw.map((v) => v / length);
  const bitangent = [
    normal[1] * tangent[2] - normal[2] * tangent[1],
    normal[2] * tangent[0] - normal[0] * tangent[2],
    normal[0] * tangent[1] - normal[1] * tangent[0],
  ];
  return { tangent, bitangent };
}

function cosineDirection(normal, u1, u2) {
  const radius = Math.sqrt(u1);
  const phi = 2 * Math.PI * u2;
  const x = radius * Math.cos(phi);
  const y = radius * Math.sin(phi);
  const z = Math.sqrt(Math.max(0, 1 - u1));
  const { tangent, bitangent } = orthonormalBasis(normal);
  return [0, 1, 2].map((i) => tangent[i] * x + bitangent[i] * y + normal[i] * z);
}

/* @important A ray leaves a surface by an amount that scales with the coordinate it is added to,
   never by a constant in metres. The renderer had to be taught that by design section 07's A3; it is
   written the same way here on purpose, because a reference that repeats the renderer's mistake
   cannot catch it, and this one is arrived at from double precision rather than from f32. */
function offsetOrigin(point, normal) {
  const reach = Math.max(Math.abs(point[0]), Math.abs(point[1]), Math.abs(point[2]));
  const lift = Math.max(reach * 1e-12, 1e-13);
  return point.map((v, i) => v + normal[i] * lift);
}

function directIrradiance(bodies, point, normal, sun, intensity) {
  const cosine = normal[0] * sun[0] + normal[1] * sun[1] + normal[2] * sun[2];
  if (cosine <= 0) return 0;
  if (occluded(bodies, offsetOrigin(point, normal), sun, Infinity)) return 0;
  return intensity * cosine;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function indirectAtPoint(bodies, point, normal, options = {}) {
  const {
    paths = 4096,
    maxBounces = 6,
    seed = 1,
    sun,
    intensity,
    sky = 0,
  } = options;
  if (!Array.isArray(sun) || !(intensity > 0)) throw new Error('indirectAtPoint needs the sun the renderer actually used: pass { sun, intensity } read off the page');
  const random = mulberry32(seed);
  let total = 0;
  for (let path = 0; path < paths; path++) {
    let origin = point;
    let surface = normal;
    let throughput = 1;
    for (let bounce = 0; bounce < maxBounces; bounce++) {
      const direction = cosineDirection(surface, random(), random());
      const hit = intersect(bodies, offsetOrigin(origin, surface), direction);
      if (!hit) { total += throughput * sky; break; }
      total += throughput * hit.albedo * directIrradiance(bodies, hit.point, hit.normal, sun, intensity) / Math.PI;
      throughput *= hit.albedo;
      if (throughput < 1e-4) break;
      origin = hit.point;
      surface = hit.normal;
    }
  }
  return total / paths;
}
