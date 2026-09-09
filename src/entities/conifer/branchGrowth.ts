import * as THREE from 'three';

export interface BranchLevel {
  angleDegrees: number;
  length: number;
  radiusFactor: number;
  taper: number;
  children: number;
  sections: number;
  segments: number;
  droop: number;
  gnarl: number;
  childStart: number;
}

export interface SpruceGrowthPreset {
  height: number;
  trunkRadius: number;
  trunkSections: number;
  trunkSegments: number;
  crownStart: number;
  whorls: number;
  branchesPerWhorl: number;
  levels: BranchLevel[];
  barkRepeatsAcross: number;
  barkMetresPerRepeat: number;
}

export interface TwigFrame {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  length: number;
  order: number;
}

export interface SpruceGrowth {
  wood: THREE.BufferGeometry;
  twigs: TwigFrame[];
  woodTriangles: number;
}

interface Ring {
  centre: THREE.Vector3;
  frame: THREE.Matrix4;
  radius: number;
}

class WoodMesh {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly indices: number[] = [];

  constructor(private readonly repeatsAcross: number, private readonly metresPerRepeat: number) {}

  tube(rings: Ring[], segments: number, vStart: number): void {
    const first = this.positions.length / 3;
    const radial = new THREE.Vector3();
    let v = vStart;
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      if (r > 0) v += ring.centre.distanceTo(rings[r - 1].centre) / this.metresPerRepeat;
      for (let s = 0; s <= segments; s++) {
        const angle = (s / segments) * Math.PI * 2;
        radial.set(Math.cos(angle), 0, Math.sin(angle)).applyMatrix4(ring.frame).normalize();
        this.positions.push(
          ring.centre.x + radial.x * ring.radius,
          ring.centre.y + radial.y * ring.radius,
          ring.centre.z + radial.z * ring.radius,
        );
        this.normals.push(radial.x, radial.y, radial.z);
        this.uvs.push((s / segments) * this.repeatsAcross, v);
      }
    }
    const stride = segments + 1;
    for (let r = 0; r < rings.length - 1; r++) {
      for (let s = 0; s < segments; s++) {
        const a = first + r * stride + s;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        this.indices.push(a, c, b, b, c, d);
      }
    }
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setIndex(this.indices);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }
}

function frameFrom(direction: THREE.Vector3): THREE.Matrix4 {
  const up = Math.abs(direction.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3().crossVectors(up, direction).normalize();
  const other = new THREE.Vector3().crossVectors(direction, side).normalize();
  return new THREE.Matrix4().makeBasis(side, direction.clone().normalize(), other);
}

interface GrowContext {
  mesh: WoodMesh;
  twigs: TwigFrame[];
  preset: SpruceGrowthPreset;
  random: () => number;
}

function growAxis(context: GrowContext, origin: THREE.Vector3, direction: THREE.Vector3, level: number, length: number, radius: number): void {
  const spec = context.preset.levels[level];
  const rings: Ring[] = [];
  const heading = direction.clone().normalize();
  const point = origin.clone();
  const step = length / spec.sections;
  for (let section = 0; section <= spec.sections; section++) {
    const t = section / spec.sections;
    rings.push({ centre: point.clone(), frame: frameFrom(heading), radius: radius * (1 - spec.taper * t) });
    if (section === spec.sections) break;
    heading.y -= spec.droop / spec.sections;
    heading.x += (context.random() - 0.5) * spec.gnarl / spec.sections;
    heading.z += (context.random() - 0.5) * spec.gnarl / spec.sections;
    heading.normalize();
    point.addScaledVector(heading, step);
  }
  context.mesh.tube(rings, spec.segments, 0);

  const child = context.preset.levels[level + 1];
  if (!child) {
    context.twigs.push({ origin: origin.clone(), direction: direction.clone().normalize(), length, order: level });
    return;
  }
  for (let i = 0; i < spec.children; i++) {
    const t = spec.childStart + (1 - spec.childStart) * ((i + 0.5) / spec.children);
    const at = ringAt(rings, t);
    const side = i % 2 === 0 ? 1 : -1;
    const childDirection = heading
      .clone()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), side * THREE.MathUtils.degToRad(child.angleDegrees) * (0.8 + context.random() * 0.4));
    childDirection.y -= child.droop * 0.5;
    childDirection.normalize();
    const childLength = length * child.length * (0.75 + context.random() * 0.5) * (1 - 0.55 * t);
    growAxis(context, at.centre.clone(), childDirection, level + 1, childLength, at.radius * child.radiusFactor);
  }
  context.twigs.push({ origin: origin.clone(), direction: direction.clone().normalize(), length, order: level });
}

function ringAt(rings: Ring[], t: number): Ring {
  const scaled = THREE.MathUtils.clamp(t, 0, 1) * (rings.length - 1);
  const index = Math.min(rings.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const a = rings[index];
  const b = rings[index + 1];
  return {
    centre: a.centre.clone().lerp(b.centre, local),
    frame: a.frame,
    radius: a.radius + (b.radius - a.radius) * local,
  };
}

export function growSpruce(preset: SpruceGrowthPreset, random: () => number): SpruceGrowth {
  const mesh = new WoodMesh(preset.barkRepeatsAcross, preset.barkMetresPerRepeat);
  const context: GrowContext = { mesh, twigs: [], preset, random };
  const trunkRings: Ring[] = [];
  const heading = new THREE.Vector3(0, 1, 0);
  const point = new THREE.Vector3();
  for (let section = 0; section <= preset.trunkSections; section++) {
    const t = section / preset.trunkSections;
    trunkRings.push({
      centre: point.clone(),
      frame: frameFrom(heading),
      radius: preset.trunkRadius * (1 - 0.82 * t) + preset.trunkRadius * 0.35 * Math.exp(-t * 14),
    });
    if (section === preset.trunkSections) break;
    heading.x += (random() - 0.5) * 0.012;
    heading.z += (random() - 0.5) * 0.012;
    heading.normalize();
    point.addScaledVector(heading, preset.height / preset.trunkSections);
  }
  mesh.tube(trunkRings, preset.trunkSegments, 0);

  const branch = preset.levels[0];
  for (let whorl = 0; whorl < preset.whorls; whorl++) {
    const t = preset.crownStart + (1 - preset.crownStart) * (whorl / (preset.whorls - 1));
    const at = ringAt(trunkRings, t);
    const count = Math.max(3, Math.round(preset.branchesPerWhorl * (1 - 0.45 * t)));
    for (let i = 0; i < count; i++) {
      const azimuth = (i / count) * Math.PI * 2 + whorl * 1.3 + random() * 0.5;
      const tilt = THREE.MathUtils.degToRad(90 - branch.angleDegrees) - (1 - t) * 0.25;
      const direction = new THREE.Vector3(Math.cos(azimuth) * Math.cos(tilt), Math.sin(tilt), Math.sin(azimuth) * Math.cos(tilt)).normalize();
      const length = preset.height * branch.length * (1 - 0.72 * t) * (0.8 + random() * 0.4);
      growAxis(context, at.centre.clone(), direction, 0, length, at.radius * branch.radiusFactor);
    }
  }

  return { wood: mesh.build(), twigs: context.twigs, woodTriangles: mesh.triangleCount };
}
