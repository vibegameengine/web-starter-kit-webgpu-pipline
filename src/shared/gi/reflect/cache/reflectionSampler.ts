import * as THREE from 'three/webgpu';
import { If, Loop, dFdx, dFdy, float, uint, uniform, vec3, vec4 } from 'three/tsl';
import { ReflectionResources } from './reflectionResources.ts';
import { SLOT_RECORD_VECS } from './reflectionTypes.ts';
import {
  boxDirection,
  faceOfDirection,
  fetchRoughness,
  mipOffsetArray,
  tapOffsetArray,
  texelOfFace,
  type ChainReader,
} from './reflectionCubeTsl.ts';

type N = THREE.Node;

export interface ReflectionSurface {
  worldPosition: N;
  worldNormal: N;
  viewDirection: N;
  roughness: N;
  regionId: N;
}

export interface ReflectionLookup {
  radiance: N;
  sourceKind: N;
  approximate: N;
  taps: N;
}

export interface ReflectionProvider {
  sample(surface: ReflectionSurface): ReflectionLookup;
}

interface Candidate {
  slot: N;
  bank: N;
  anchor: N;
  center: N;
  halfSize: N;
  freshness: N;
}

interface LocalSurface {
  position: N;
  reflected: N;
}

export class ReflectionSampler implements ReflectionProvider {
  readonly intensity = uniform(1);
  readonly wideBlendRoughness = uniform(0.3);
  readonly depthCorrection = uniform(1);
  readonly maxTaps = uniform(8);
  readonly debugMode = uniform(0);
  private readonly chain: ChainReader;
  private readonly taps = tapOffsetArray();

  constructor(private readonly resources: ReflectionResources) {
    this.chain = {
      layout: resources.layout,
      slots: resources.slots,
      radiance: resources.radianceRead,
      offsets: mipOffsetArray(resources.layout),
    };
  }

  private record(slot: N, index: number): N {
    const table = this.resources.tableRead as unknown as { element: (i: N) => N };
    return vec4(table.element(uint(float(slot).mul(SLOT_RECORD_VECS).add(index))));
  }

  private candidateAt(slot: N): Candidate {
    const anchorRecord = this.record(slot, 0);
    const proxyCentre = this.record(slot, 1);
    const proxyHalf = this.record(slot, 2);
    const bankRecord = this.record(slot, 5);
    const status = this.record(slot, 7);
    return {
      slot,
      bank: bankRecord.w,
      anchor: anchorRecord.xyz,
      center: proxyCentre.xyz,
      halfSize: proxyHalf.xyz,
      freshness: status.w,
    };
  }

  private ownerWeight(slot: N, position: N, regionId: N, wide: N): N {
    const anchorRecord = this.record(slot, 0);
    const ownMin = this.record(slot, 3);
    const ownMax = this.record(slot, 4);
    const infMin = this.record(slot, 5);
    const infMax = this.record(slot, 6);
    const p = vec3(position);
    const readable = infMax.w.greaterThan(0.5);
    const sameRegion = anchorRecord.w.sub(float(regionId)).abs().lessThan(0.5);
    const insideOwn = p.x.greaterThanEqual(ownMin.x).and(p.y.greaterThanEqual(ownMin.y)).and(p.z.greaterThanEqual(ownMin.z))
      .and(p.x.lessThanEqual(ownMax.x)).and(p.y.lessThanEqual(ownMax.y)).and(p.z.lessThanEqual(ownMax.z));
    const insideInfluence = p.x.greaterThanEqual(infMin.x).and(p.y.greaterThanEqual(infMin.y)).and(p.z.greaterThanEqual(infMin.z))
      .and(p.x.lessThanEqual(infMax.x)).and(p.y.lessThanEqual(infMax.y)).and(p.z.lessThanEqual(infMax.z));
    const centre = infMin.xyz.add(infMax.xyz).mul(0.5);
    const extent = infMax.xyz.sub(infMin.xyz).mul(0.5).max(1e-3);
    const normalised = p.sub(centre).div(extent).abs();
    const spatial = float(1).sub(normalised.x.max(normalised.y).max(normalised.z)).clamp(0, 1).pow(2).add(1e-4);
    const narrowWeight = insideOwn.select(float(1), float(0));
    const wideWeight = insideInfluence.select(spatial, float(0));
    return readable.and(sameRegion).select(wide.greaterThan(0.5).select(wideWeight, narrowWeight), float(0));
  }

  private depthAt(candidate: Candidate, direction: N): N {
    const { layout, slots } = this.chain;
    const buffer = this.resources.depthRead as unknown as { element: (i: N) => N };
    const ft = faceOfDirection(direction);
    const side = float(layout.faceSize);
    const ix = ft.y.mul(0.5).add(0.5).mul(side).floor().clamp(0, side.sub(1));
    const iy = ft.z.mul(0.5).add(0.5).mul(side).floor().clamp(0, side.sub(1));
    const base = float(candidate.bank).mul(slots).add(float(candidate.slot)).mul(layout.baseTexels);
    return vec4(buffer.element(uint(base).add(texelOfFace(ft.x, ix, iy, side))));
  }

  private correctedDirection(candidate: Candidate, local: LocalSurface): N {
    const proxy = { anchor: candidate.anchor, center: candidate.center, halfSize: candidate.halfSize };
    const projected = boxDirection(proxy, local.position, local.reflected);
    const direction = vec3(projected.xyz).toVar();
    If(this.depthCorrection.greaterThan(0.5), () => {
      Loop(2, () => {
        const depth = this.depthAt(candidate, direction);
        const known = depth.w.greaterThan(0.5);
        const hit = vec3(candidate.anchor).add(vec3(direction).mul(depth.x));
        const along = vec3(hit).sub(local.position).dot(vec3(local.reflected));
        const residual = vec3(hit).sub(local.position).sub(vec3(local.reflected).mul(along)).length();
        const trusted = known.and(along.greaterThan(0)).and(residual.lessThan(depth.x.mul(0.25).add(0.05)));
        direction.assign(trusted.select(vec3(hit).sub(candidate.anchor).normalize(), direction));
      });
    });
    return direction;
  }

  private tapCount(position: N, normal: N, reflected: N): N {
    const spread = dFdx(vec3(reflected)).length().add(dFdy(vec3(reflected)).length())
      .add(dFdx(vec3(normal)).length().add(dFdy(vec3(normal)).length()))
      .add(dFdx(vec3(position)).length().add(dFdy(vec3(position)).length()).mul(0.05));
    const wanted = spread.greaterThan(0.12).select(float(8), spread.greaterThan(0.03).select(float(4), float(1)));
    return wanted.min(this.maxTaps).max(1);
  }

  sample(surface: ReflectionSurface): ReflectionLookup {
    const result = vec4((() => {
      const position = vec3(surface.worldPosition);
      const normal = vec3(surface.worldNormal).normalize();
      const view = vec3(surface.viewDirection).normalize();
      const roughness = float(surface.roughness).clamp(0, 1);
      const incident = view.negate();
      const reflected = incident.sub(normal.mul(incident.dot(normal).mul(2))).normalize();
      const wide = roughness.greaterThanEqual(this.wideBlendRoughness).select(float(1), float(0));
      const dPdx = dFdx(position);
      const dPdy = dFdy(position);
      const dNdx = dFdx(normal);
      const dNdy = dFdy(normal);
      const taps = this.tapCount(position, normal, reflected).toVar();
      const sum = vec3(0).toVar();
      const weightSum = float(0).toVar();
      const freshest = float(2).toVar();
      Loop(taps, ({ i: tap }: { i: N }) => {
        const offset = vec4(this.taps.element(tap)).xy;
        const localPosition = position.add(dPdx.mul(offset.x)).add(dPdy.mul(offset.y));
        const localNormal = normal.add(dNdx.mul(offset.x)).add(dNdy.mul(offset.y)).normalize();
        const localIncident = localPosition.sub(position).add(incident).normalize();
        const localReflected = localIncident.sub(localNormal.mul(localIncident.dot(localNormal).mul(2))).normalize();
        const local: LocalSurface = { position: localPosition, reflected: localReflected };
        Loop(this.resources.slots, ({ i: slot }: { i: N }) => {
          const weight = this.ownerWeight(slot, localPosition, surface.regionId, wide);
          If(weight.greaterThan(0), () => {
            const candidate = this.candidateAt(slot);
            const direction = this.correctedDirection(candidate, local);
            sum.addAssign(vec3(fetchRoughness(this.chain, { slot: candidate.slot, bank: candidate.bank }, roughness, direction)).mul(weight));
            weightSum.addAssign(weight);
            freshest.assign(freshest.min(candidate.freshness));
          });
        });
      });
      const radiance = weightSum.greaterThan(0).select(vec3(sum).div(weightSum), vec3(0)).mul(this.intensity);
      const debugWeight = vec3(weightSum);
      const debugDirection = vec3(reflected).abs();
      const debugTaps = vec3(taps).div(8);
      const debugged = this.debugMode.lessThan(0.5).select(radiance,
        this.debugMode.lessThan(1.5).select(debugWeight,
          this.debugMode.lessThan(2.5).select(debugDirection, debugTaps)));
      return vec4(debugged, weightSum.greaterThan(0).select(float(1).sub(freshest.mul(0.5)), float(0)));
    })());
    return { radiance: result.rgb, sourceKind: result.w, approximate: result.w.lessThan(0.75).select(float(1), float(0)), taps: float(0) };
  }
}
