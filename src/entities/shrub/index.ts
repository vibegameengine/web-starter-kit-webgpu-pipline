import * as THREE from 'three/webgpu';
import { positionLocal, sin, uniform, vec3, vertexColor } from 'three/tsl';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createNoise, seededRandom } from '../../shared/lib/noise';
import { installVertexMotion } from '../../shared/render/vertexMotion.ts';
import {
  LEAF_PRESETS,
  buildLeafRamp,
  mixBiochemistry,
  sampleLeafRamp,
  veinTint,
  type LeafBiochemistry,
  type LeafRamp,
  type RGB,
} from '../foliage/leafOptics.ts';
import { createLeafMaterial } from '../foliage/leafMaterial.ts';
import { buildLeafSurface, type LeafSurface, type Venation } from '../foliage/leafSurface.ts';

/**
 * Tropical undergrowth shrub: a rosette of arching broad leaves and/or small
 * palmetto-style fan fronds built as real geometry (no alpha cards).
 * Units are metres, +Y up, origin at the ground centre of the plant.
 */
export interface ShrubOptions {
  seed: number;
  /** Footprint radius in metres, 0.4..1.2. Leaves reach roughly this far out. */
  radius: number;
  kind?: 'broadleaf' | 'fan' | 'mixed';
  /** Sky for the leaves' cuticle reflection and back-lit transmission. */
  environment?: THREE.Texture;
}

export interface Shrub {
  group: THREE.Group;
  update(timeSec: number): void;
}

type Rng = () => number;

const UP = new THREE.Vector3(0, 1, 0);
const DEG = Math.PI / 180;

const STEM_BASE = new THREE.Color(0.16, 0.12, 0.05);
const STEM_TOP = new THREE.Color(0.20, 0.26, 0.07);

let loggedTriangles = false;

/** Accumulates vertex data for one leaf or stem, then bakes it to an indexed geometry. */
class LeafBuilder {
  positions: number[] = [];
  colors: number[] = [];
  transmittances: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];

  /** `c` is the linear reflectance, `t` the linear transmittance (zero for a stem). */
  vertex(p: THREE.Vector3, c: RGB, u: number, v: number, t: RGB = [0, 0, 0]): number {
    const id = this.positions.length / 3;
    this.positions.push(p.x, p.y, p.z);
    this.colors.push(c[0], c[1], c[2]);
    this.transmittances.push(t[0], t[1], t[2]);
    this.uvs.push(u, v);
    return id;
  }

  /** a-b is the near row, c-d the far row, same left-to-right ordering. */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, c, b, b, c, d);
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute('transmittance', new THREE.Float32BufferAttribute(this.transmittances, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setIndex(this.indices);
    return geometry;
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smooth(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * Per-leaf optics: chlorophyll varies ±25% from leaf to leaf, the tip of a
 * blade is younger tissue than its base, inner leaves are young, and one outer
 * leaf in seven is an old one losing chlorophyll and browning.
 */
function leafRampFor(rng: Rng, kind: 'broad' | 'fan', youth: number): LeafRamp {
  const variation = 1 + (rng() * 2 - 1) * 0.25;
  const old = youth < 0.5 && rng() < 0.15 ? 0.55 + rng() * 0.35 : 0;
  const mature = kind === 'fan' ? LEAF_PRESETS.fan : LEAF_PRESETS.broadleaf;
  const young = kind === 'fan' ? mixBiochemistry(LEAF_PRESETS.fan, LEAF_PRESETS.broadleafYoung, 0.6) : LEAF_PRESETS.broadleafYoung;
  const vary = (b: LeafBiochemistry): LeafBiochemistry => ({ ...b, Cab: b.Cab * variation, Car: b.Car * (0.9 + 0.1 * variation) });
  // The rosette grows from the centre: the innermost leaves are the youngest.
  let base = vary(mixBiochemistry(mature, young, youth * 0.65));
  let tip = vary(mixBiochemistry(base, young, 0.5));
  if (old > 0) {
    base = mixBiochemistry(base, LEAF_PRESETS.broadleafOld, old * 0.5);
    tip = mixBiochemistry(tip, LEAF_PRESETS.broadleafOld, old);
  }
  return buildLeafRamp(base, tip, 8);
}

/** Relief maps are shared by every shrub: they describe the species, not the plant. */
const surfaceCache = new Map<Venation, LeafSurface>();
function leafSurfaceFor(venation: Venation): LeafSurface {
  let surface = surfaceCache.get(venation);
  if (!surface) {
    surface = buildLeafSurface({
      venation,
      width: venation === 'pinnate' ? 0.12 : 0.05,
      length: venation === 'pinnate' ? 0.5 : 0.35,
      noise: createNoise(venation === 'pinnate' ? 901 : 902),
    });
    surfaceCache.set(venation, surface);
  }
  return surface;
}

/** Vertices across a broad leaf blade. */
const ACROSS = 5;

interface BroadleafSpec {
  attach: THREE.Vector3;
  azimuth: number;
  elevation: number;
  length: number;
  width: number;
  arch: number;
  droop: number;
  fold: number;
  twist: number;
  segments: number;
  ramp: LeafRamp;
}

/**
 * Elliptic leaf blade: a strip of `segments` along the midrib x 2 across.
 * The midrib arches up then droops under gravity; the two halves fold down.
 */
function buildBroadleaf(spec: BroadleafSpec): THREE.BufferGeometry {
  const builder = new LeafBuilder();
  const { azimuth, elevation, length, width, arch, droop, fold, twist, segments } = spec;
  const dir = new THREE.Vector3(
    Math.cos(elevation) * Math.cos(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.sin(azimuth),
  );
  const side = new THREE.Vector3(-Math.sin(azimuth), 0, Math.cos(azimuth));
  const point = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const rows = segments + 1;

  for (let r = 0; r < rows; r++) {
    const t = r / segments;
    // Midrib: straight along dir, lifted by an arch, then pulled down by droop.
    const lift = arch * Math.sin(Math.PI * t) * length - droop * t * t * length;
    mid.copy(spec.attach).addScaledVector(dir, t * length).addScaledVector(UP, lift);
    // Elliptic half width: narrow petiole at the base, widest past the middle, pointed tip.
    const shape = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.85)), 0.65);
    const halfWidth = width * shape;
    // Lateral droop: the two halves fold down; a small twist rocks the fold.
    const foldDrop = fold * halfWidth;
    const twistDrop = Math.sin(twist * t) * halfWidth * 0.35;
    const optics = sampleLeafRamp(spec.ramp, smooth(t * 1.1));

    // Five vertices across: the halves curve down from the midrib rather than
    // folding at a crease, so the shading does not read as two flat facets.
    for (let k = 0; k < ACROSS; k++) {
      const s = (k / (ACROSS - 1)) * 2 - 1;
      point.copy(mid).addScaledVector(side, s * halfWidth);
      point.y -= s * s * foldDrop + s * twistDrop;
      if (point.y < 0.012) point.y = 0.012;
      builder.vertex(point, optics.R, (s + 1) * 0.5, t, optics.T);
    }
  }

  for (let r = 0; r < segments; r++) {
    const a = r * ACROSS;
    const b = a + ACROSS;
    for (let k = 0; k < ACROSS - 1; k++) builder.quad(a + k, a + k + 1, b + k, b + k + 1);
  }
  return builder.build();
}

interface FanSpec {
  hub: THREE.Vector3;
  azimuth: number;
  tilt: number;
  blades: number;
  spanHalf: number;
  bladeLength: number;
  bladeWidth: number;
  droop: number;
  fold: number;
  ramp: LeafRamp;
}

/**
 * Palmetto-style fan: `blades` narrow segments radiating from the hub in a
 * tilted plane, each a 4-row strip x 2 across with a pointed tip.
 */
function buildFan(spec: FanSpec): THREE.BufferGeometry {
  const builder = new LeafBuilder();
  const { azimuth, tilt, blades, spanHalf, bladeLength, bladeWidth, droop, fold } = spec;
  const forward = new THREE.Vector3(
    Math.cos(tilt) * Math.cos(azimuth),
    Math.sin(tilt),
    Math.cos(tilt) * Math.sin(azimuth),
  );
  const side = new THREE.Vector3(-Math.sin(azimuth), 0, Math.cos(azimuth));
  const normal = new THREE.Vector3().crossVectors(side, forward).normalize();
  if (normal.y < 0) normal.negate();

  const bladeDir = new THREE.Vector3();
  const bladeSide = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const point = new THREE.Vector3();
  const rowsPerBlade = 4;
  const rowCount = rowsPerBlade + 1;

  for (let b = 0; b < blades; b++) {
    const u = blades === 1 ? 0.5 : b / (blades - 1);
    const phi = lerp(-spanHalf, spanHalf, u);
    bladeDir.copy(forward).multiplyScalar(Math.cos(phi)).addScaledVector(side, Math.sin(phi));
    bladeSide.copy(forward).multiplyScalar(-Math.sin(phi)).addScaledVector(side, Math.cos(phi));
    // Outer blades hang lower so the fan curls like a real palmetto.
    const edge = Math.abs(phi) / spanHalf;
    const bladeDroop = droop * (0.6 + 0.8 * edge * edge);
    const length = bladeLength * (0.8 + 0.2 * (1 - edge * edge));
    const first = builder.positions.length / 3;

    for (let r = 0; r < rowCount; r++) {
      const t = r / rowsPerBlade;
      mid.copy(spec.hub).addScaledVector(bladeDir, t * length);
      mid.y -= bladeDroop * t * t * length;
      // Blades fuse near the hub, are widest at about a third of their length, and end in a point.
      const halfWidth =
        bladeWidth * (0.72 + 0.28 * Math.sin(Math.PI * Math.pow(t, 0.7))) * (1 - t * t);
      const optics = sampleLeafRamp(spec.ramp, smooth(t * 1.05));
      for (let s = -1; s <= 1; s++) {
        point.copy(mid).addScaledVector(bladeSide, s * halfWidth);
        point.addScaledVector(normal, -Math.abs(s) * fold * halfWidth);
        if (point.y < 0.012) point.y = 0.012;
        builder.vertex(point, optics.R, (s + 1) * 0.5, t, optics.T);
      }
    }

    for (let r = 0; r < rowsPerBlade; r++) {
      const a = first + r * 3;
      const c = a + 3;
      builder.quad(a, a + 1, c, c + 1);
      builder.quad(a + 1, a + 2, c + 1, c + 2);
    }
  }
  return builder.build();
}

/** Thin three-sided stem from `from` to `to`, open-ended, tapering toward the tip. */
function buildStem(from: THREE.Vector3, to: THREE.Vector3, radius: number): THREE.BufferGeometry {
  const builder = new LeafBuilder();
  const axis = new THREE.Vector3().subVectors(to, from);
  const length = axis.length();
  axis.divideScalar(length || 1);
  const ref = Math.abs(axis.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP;
  const tangent = new THREE.Vector3().crossVectors(axis, ref).normalize();
  const bitangent = new THREE.Vector3().crossVectors(axis, tangent).normalize();
  const point = new THREE.Vector3();
  const color = new THREE.Color();
  const sides = 3;

  for (let ring = 0; ring < 2; ring++) {
    const rr = ring === 0 ? radius : radius * 0.55;
    color.copy(STEM_BASE).lerp(STEM_TOP, ring);
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      point
        .copy(ring === 0 ? from : to)
        .addScaledVector(tangent, Math.cos(a) * rr)
        .addScaledVector(bitangent, Math.sin(a) * rr);
      builder.vertex(point, [color.r, color.g, color.b], i / sides, ring);
    }
  }
  for (let i = 0; i < sides; i++) {
    builder.quad(i, i + 1, i + sides + 1, i + sides + 2);
  }
  return builder.build();
}

function finishGeometry(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  return index ? index.count / 3 : geometry.getAttribute('position').count / 3;
}

export function createShrub(options: ShrubOptions): Shrub {
  const kind = options.kind ?? 'mixed';
  const radius = THREE.MathUtils.clamp(options.radius, 0.4, 1.2);
  const rng = seededRandom(options.seed);
  const scale = radius / 0.8;

  const leafParts: THREE.BufferGeometry[] = [];
  const stemParts: THREE.BufferGeometry[] = [];
  const ramps: LeafRamp[] = [];
  const crown = new THREE.Vector3();
  const attach = new THREE.Vector3();
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  let azimuthCursor = rng() * Math.PI * 2;

  const nextAzimuth = (): number => {
    azimuthCursor += goldenAngle + (rng() - 0.5) * 0.35;
    return azimuthCursor;
  };

  const wantBroad = kind !== 'fan';
  const wantFan = kind !== 'broadleaf';
  const mixedScale = kind === 'mixed' ? 0.65 : 1;
  const broadCount = wantBroad
    ? Math.round(THREE.MathUtils.clamp(radius * 52, 25, 60) * mixedScale)
    : 0;
  const fanCount = wantFan
    ? Math.round(THREE.MathUtils.clamp(6 + radius * 7, 8, 14) * (kind === 'mixed' ? 0.7 : 1))
    : 0;

  // --- Broad leaves: a rosette radiating outward; outer leaves flatter and longer.
  for (let i = 0; i < broadCount; i++) {
    // u: 0 = outer, ground-hugging leaf; 1 = inner, upright young leaf.
    const u = Math.pow(i / Math.max(1, broadCount - 1), 1.15);
    const azimuth = nextAzimuth();
    const elevation = lerp(6, 80, u) * DEG + (rng() - 0.5) * 10 * DEG;
    // Inner leaves stand on taller petioles (bird-of-paradise habit), outer ones sprawl.
    const stemLength = radius * lerp(0.24, 0.34, u) * (0.85 + rng() * 0.3);
    const length = radius * lerp(0.98, 0.62, u) * (0.85 + rng() * 0.3);
    const ramp = leafRampFor(rng, 'broad', u);
    ramps.push(ramp);

    crown.set((rng() - 0.5) * 0.06 * scale, 0.02 + u * 0.06 * scale, (rng() - 0.5) * 0.06 * scale);
    attach.set(
      crown.x + Math.cos(elevation) * Math.cos(azimuth) * stemLength,
      crown.y + Math.sin(elevation) * stemLength,
      crown.z + Math.cos(elevation) * Math.sin(azimuth) * stemLength,
    );

    leafParts.push(
      buildBroadleaf({
        attach: attach.clone(),
        azimuth,
        elevation,
        length,
        width: length * lerp(0.13, 0.18, rng()),
        arch: lerp(0.12, 0.26, rng()) * (0.6 + 0.4 * u),
        droop: lerp(0.06, 0.28, u) * (0.7 + rng() * 0.6),
        fold: lerp(0.1, 0.32, rng()),
        twist: (rng() - 0.5) * 2.5,
        segments: 8,
        ramp,
      }),
    );
    stemParts.push(buildStem(crown.clone(), attach.clone(), 0.007 * scale));
  }

  // --- Fan fronds: fewer, on longer stems, held up and tilted outward.
  for (let i = 0; i < fanCount; i++) {
    const u = i / Math.max(1, fanCount - 1);
    const azimuth = nextAzimuth();
    const stemElev = lerp(32, 78, u) * DEG + (rng() - 0.5) * 14 * DEG;
    const stemLength = radius * lerp(0.8, 0.92, u) * (0.85 + rng() * 0.3);
    const tilt = stemElev - lerp(30, 50, rng()) * DEG;
    const bladeLength = radius * lerp(0.5, 0.36, u) * (0.85 + rng() * 0.3);
    const blades = 12 + Math.floor(rng() * 7);
    const ramp = leafRampFor(rng, 'fan', u * 0.5);
    ramps.push(ramp);

    crown.set((rng() - 0.5) * 0.08 * scale, 0.02, (rng() - 0.5) * 0.08 * scale);
    attach.set(
      crown.x + Math.cos(stemElev) * Math.cos(azimuth) * stemLength,
      crown.y + Math.sin(stemElev) * stemLength,
      crown.z + Math.cos(stemElev) * Math.sin(azimuth) * stemLength,
    );

    leafParts.push(
      buildFan({
        hub: attach.clone(),
        azimuth,
        tilt,
        blades,
        spanHalf: lerp(62, 80, rng()) * DEG,
        bladeLength,
        bladeWidth: bladeLength * lerp(0.09, 0.115, rng()),
        droop: lerp(0.1, 0.3, rng()),
        fold: lerp(0.2, 0.5, rng()),
        ramp,
      }),
    );
    stemParts.push(buildStem(crown.clone(), attach.clone(), 0.009 * scale));
  }

  const leafGeometry = finishGeometry(leafParts);
  const stemGeometry = finishGeometry(stemParts);

  // --- Materials. The vertex colour carries the base-to-tip ramp; material.color is the
  // average so anything that only reads material.color (a ray tracer, a bake) stays plausible.
  const windTime = uniform(0);
  const windTimePrev = uniform(0);
  const meanR: RGB = [0, 0, 0];
  let meanT = 0;
  for (const ramp of ramps) {
    meanR[0] += ramp.meanR[0] / ramps.length;
    meanR[1] += ramp.meanR[1] / ramps.length;
    meanR[2] += ramp.meanR[2] / ramps.length;
    meanT += ramp.meanTLuminance / ramps.length;
  }
  const leafMaterial = createLeafMaterial({
    surface: leafSurfaceFor(kind === 'fan' ? 'parallel' : 'pinnate'),
    ior: 1.42,
    meanReflectance: meanR,
    meanTransmittance: meanT,
    veinTint: veinTint(kind === 'fan' ? LEAF_PRESETS.fan : LEAF_PRESETS.broadleaf),
    environment: options.environment,
    name: `shrub-leaf-${kind}`,
  });
  {
    // Wind: sway grows with height above ground; two frequencies so it never reads as a
    // metronome. A function of the wind clock so the motion vector can evaluate the
    // previous frame's sway (vertexMotion.ts).
    const height = positionLocal.y;
    const phase = positionLocal.x.mul(2.3).add(positionLocal.z.mul(1.7));
    const displaceAt = (t: ReturnType<typeof uniform>) => {
      const swayA = sin(t.mul(1.6).add(phase)).mul(height).mul(0.022);
      const swayB = sin(t.mul(2.45).add(phase.mul(1.31)).add(1.7)).mul(height).mul(0.014);
      return vec3(swayA, swayB.mul(0.4), swayB);
    };
    installVertexMotion(leafMaterial, displaceAt, windTime, windTimePrev);
  }

  // `colorNode` carries the vertex colour; `vertexColors: true` on top of it
  // multiplied the colour in twice and painted the stems black.
  const stemMaterial = new THREE.MeshStandardNodeMaterial({
    color: STEM_BASE.clone().lerp(STEM_TOP, 0.5),
    roughness: 0.75,
    metalness: 0,
  });
  stemMaterial.colorNode = vertexColor();

  const leaves = new THREE.Mesh(leafGeometry, leafMaterial);
  leaves.name = 'shrubLeaves';
  leaves.castShadow = true;
  leaves.receiveShadow = true;
  leaves.userData.animatesVertices = true;
  leaves.userData.lightmap = false;

  const stems = new THREE.Mesh(stemGeometry, stemMaterial);
  stems.name = 'shrubStems';
  stems.castShadow = true;
  stems.receiveShadow = true;
  stems.userData.lightmap = false;

  const group = new THREE.Group();
  group.name = `shrub-${kind}-${options.seed}`;
  group.add(leaves, stems);

  if (!loggedTriangles) {
    loggedTriangles = true;
    console.info(
      `[shrub] ${kind} r=${radius.toFixed(2)} leaves=${triangleCount(leafGeometry)} tris, ` +
        `stems=${triangleCount(stemGeometry)} tris`,
    );
  }

  return {
    group,
    update(timeSec: number): void {
      windTimePrev.value = windTime.value;
      windTime.value = timeSec;
    },
  };
}
