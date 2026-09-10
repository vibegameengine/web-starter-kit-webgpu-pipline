// @ts-nocheck -- shares vendored webgiya conventions (storage-node naming, wgslFn
// dependency lists) with sceneBvh.ts / surfelIntegratePass.ts, so it is written in the
// same style even though it has no upstream counterpart.
import * as THREE from 'three/webgpu';
import { wgsl, wgslFn } from 'three/tsl';
import {
  bvhIntersectFirstHit,
  bvhIntersectFirstHitBudget,
  bvhNodeStruct,
  constants,
  getVertexAttribute,
  intersectionResultStruct,
  intersectsBounds,
  intersectsTriangle,
  rayStruct,
} from '../bvh/webgpu/index.js';
import { Mobility } from '../../world/index.ts';
import { gatherBvhGeometries } from './sceneBvh';
import { createDynamicHierarchy } from './dynamicHierarchy';

/**
 * A second acceleration structure, over `Mobility.Movable` geometry only.
 *
 * Static geometry keeps its own immutable BVH. The dynamic structure contains a
 * world-space TLAS over immutable object-space BLASes, shared by template identity.
 * A pose update changes inverse matrices and refits only the TLAS bounds. The existing
 * four storage bindings carry both levels plus instance records; triangle buffers
 * stay untouched. syncDynamicScene replaces the bundle on membership changes.
 */
export type DynamicBVHBundle = {
  dispose: (renderer: THREE.WebGPURenderer) => void;
  // TSL Storage Nodes, named apart from the static set so both can be bound at once.
  bvhNode: THREE.StorageBufferNode;
  positionNode: THREE.StorageBufferNode;
  indexNode: THREE.StorageBufferNode;
  colorNode: THREE.StorageBufferNode;
  /** 1 while the structure holds anything worth tracing, 0 otherwise. */
  enabled: THREE.UniformNode;
  /**
   * World bounding sphere of the movers as (centre.xyz, radius), refreshed with the
   * structure. Nothing in the static integrator reads it — it is here for the dynamic
   * GI pass, which needs to know which part of the world its own probes belong in
   * without walking the scene graph again.
   */
  influence: THREE.UniformNode;
  triangleCount: number;
  moverCount: number;
  /** Refits instance bounds if any mover's world matrix changed. */
  refresh: (options?: { force?: boolean }) => boolean;
  /** Compatibility field: cost of the last TLAS refit, in ms; 0 if unchanged. */
  lastRebuildMs: number;
  hierarchyStats: () => Record<string, number>;
};

// -----------------------------------------------------------------------------
// WGSL: a second traversal, bound to the dynamic buffers.
//
// The vendored traversal in bvh/webgpu hard-codes the storage names `bvh`,
// `bvh_position`, `bvh_index`, `bvh_attribute`. There is no parameterisation to reach
// for — WGSL has no way to pass a storage binding as an argument — so the second
// structure needs a second copy of the same three functions against `dyn_*` names.
// They are otherwise byte-identical to bvh_ray_functions.wgsl.js; if that file gets an
// upstream fix, it has to be mirrored here.
// -----------------------------------------------------------------------------

export const dynIntersectTriangles = wgslFn(
  /* wgsl */ `

	fn dynIntersectTriangles(
		offset: u32,
		count: u32,
		ray: Ray
	) -> IntersectionResult {

		var closestResult: IntersectionResult;

		closestResult.didHit = false;
		closestResult.dist = INFINITY;

		for ( var i = offset; i < offset + count; i = i + 1u ) {

			let indices = dyn_bvh_index.value[ i ];
			let a = dyn_bvh_position.value[ indices.x ];
			let b = dyn_bvh_position.value[ indices.y ];
			let c = dyn_bvh_position.value[ indices.z ];

			var triResult = intersectsTriangle( ray, a, b, c );

			if ( triResult.didHit && triResult.dist < closestResult.dist ) {

				closestResult = triResult;
				closestResult.indices = vec4u( indices.xyz, i );

			}

		}

		return closestResult;

	}

`,
  [intersectsTriangle, rayStruct, intersectionResultStruct, constants],
);

export const dynLocalBvhIntersectFirstHit = wgslFn(
  /* wgsl */ `

	fn dynLocalBvhIntersectFirstHit(
		ray: Ray, root: u32
	) -> IntersectionResult {

		var pointer = 0;
		var stack: array<u32, BVH_STACK_DEPTH>;
		stack[ 0 ] = root;

		var bestHit: IntersectionResult;

		bestHit.didHit = false;
		bestHit.dist = INFINITY;

		loop {

			if ( pointer < 0 || pointer >= i32( BVH_STACK_DEPTH ) ) {

				break;

			}

			let currNodeIndex = stack[ pointer ];
			let node = dyn_bvh.value[ currNodeIndex ];

			pointer = pointer - 1;

			var boundsHitDistance: f32 = 0.0;

			if ( ! intersectsBounds( ray, node.bounds, &boundsHitDistance ) || boundsHitDistance > bestHit.dist ) {

				continue;

			}

			let boundsInfox = node.splitAxisOrTriangleCount;
			let boundsInfoy = node.rightChildOrTriangleOffset;

			let isLeaf = ( boundsInfox & 0xffff0000u ) != 0u;

			if ( isLeaf ) {

				let count = boundsInfox & 0x0000ffffu;
				let offset = boundsInfoy;

				let localHit = dynIntersectTriangles( offset, count, ray );

				if ( localHit.didHit && localHit.dist < bestHit.dist ) {

					bestHit = localHit;

				}

			} else {

				let leftIndex = currNodeIndex + 1u;
				let splitAxis = boundsInfox & 0x0000ffffu;
				let rightIndex = currNodeIndex + boundsInfoy;

				let leftToRight = ray.direction[splitAxis] >= 0.0;
				let c1 = select( rightIndex, leftIndex, leftToRight );
				let c2 = select( leftIndex, rightIndex, leftToRight );

				pointer = pointer + 1;
				stack[ pointer ] = c2;

				pointer = pointer + 1;
				stack[ pointer ] = c1;

			}

		}

		return bestHit;

	}

`,
  [
    dynIntersectTriangles,
    intersectsBounds,
    rayStruct,
    bvhNodeStruct,
    intersectionResultStruct,
    constants,
  ],
);

// TLAS leaves refer to five vec3 records appended to the existing attribute buffer:
// BLAS root/validity, then four columns of the affine inverse. No new binding.
export const dynBvhIntersectFirstHit = wgslFn(/* wgsl */ `
  fn dynBvhIntersectFirstHit(ray: Ray) -> IntersectionResult {
    var best: IntersectionResult;
    best.didHit = false; best.dist = INFINITY;
    var stack: array<u32, BVH_STACK_DEPTH>;
    var pointer = 0; stack[0] = 0u;
    loop {
      if (pointer < 0) { break; }
      let ni = stack[pointer]; pointer -= 1;
      let node = dyn_bvh.value[ni];
      var boundsDistance = 0.0;
      if (!intersectsBounds(ray, node.bounds, &boundsDistance) || boundsDistance > best.dist) { continue; }
      if ((node.splitAxisOrTriangleCount & 0xffff0000u) != 0u) {
        let base = node.rightChildOrTriangleOffset;
        let metadata = dyn_bvh_attribute.value[base];
        if (metadata.y < 0.5) { continue; }
        let inverseLinear = mat3x3f(dyn_bvh_attribute.value[base + 1u],
          dyn_bvh_attribute.value[base + 2u], dyn_bvh_attribute.value[base + 3u]);
        var localRay: Ray;
        localRay.origin = inverseLinear * ray.origin + dyn_bvh_attribute.value[base + 4u];
        // Do not normalize: t remains the original world-ray parameter, including
        // nonuniform scale/shear. Both tree levels can compare the same distance.
        localRay.direction = inverseLinear * ray.direction;
        var hit = dynLocalBvhIntersectFirstHit(localRay, u32(metadata.x));
        if (hit.didHit && hit.dist < best.dist) {
          hit.normal = normalize(transpose(inverseLinear) * hit.normal);
          best = hit;
        }
      } else {
        let left = ni + 1u; let right = ni + node.rightChildOrTriangleOffset;
        let forward = ray.direction[node.splitAxisOrTriangleCount] >= 0.0;
        pointer += 1; stack[pointer] = select(left, right, forward);
        pointer += 1; stack[pointer] = select(right, left, forward);
      }
    }
    return best;
  }
`, [dynLocalBvhIntersectFirstHit, intersectsBounds, rayStruct, bvhNodeStruct, intersectionResultStruct, constants]);

export const getDynVertexAttribute = wgslFn(/* wgsl */ `

	fn getDynVertexAttribute(
		barycoord: vec3f,
		indices: vec3u
	) -> vec3f {

		let n0 = dyn_bvh_attribute.value[ indices.x ];
		let n1 = dyn_bvh_attribute.value[ indices.y ];
		let n2 = dyn_bvh_attribute.value[ indices.z ];
		return barycoord.x * n0 + barycoord.y * n1 + barycoord.z * n2;

	}

`);

/**
 * The interpolated attribute is resolved inside the trace rather than at the call site.
 * That is the whole trick that keeps the shading path identical for both structures:
 * `uv.xy + matId` comes out of whichever attribute buffer the winning hit belongs to,
 * and nothing downstream has to know which one that was.
 */
export const sceneHitStruct = wgsl(/* wgsl */ `
	struct SceneHit {
		didHit: bool,
		dist: f32,
		normal: vec3f,
		attrib: vec3f,
		isDynamic: bool,
		indices: vec3u,
		barycoord: vec3f,
		// The static traversal stopped on its node ceiling. Whatever is in didHit is
		// then a partial answer: possibly nothing, possibly a surface with a nearer one
		// never visited.
		exhausted: bool,
	};
`);

/**
 * The cheap rejection a TLAS would be doing for us.
 *
 * Without it every ray in the world pays a second BVH descent to discover that the
 * movers are nowhere near it — measurable even in a Cornell box, and ruinous in a
 * forest where the movable set is one character inside a hundred metres of trees. One
 * ray/sphere test against the movers' world bounds throws almost all of them out.
 */
export const dynBoundsHit = wgslFn(
  /* wgsl */ `
	fn dynBoundsHit( ray: Ray, bounds: vec4f ) -> bool {

		if ( bounds.w <= 0.0 ) { return false; }

		let oc = ray.origin - bounds.xyz;
		let a = dot( ray.direction, ray.direction );
		let b = dot( oc, ray.direction );
		let c = dot( oc, oc ) - bounds.w * bounds.w;

		if ( c <= 0.0 ) { return true; }
		if ( b >= 0.0 ) { return false; }

		return b * b - a * c >= 0.0;

	}
`,
  [rayStruct],
);

/**
 * Closest hit against static and dynamic geometry, with a ceiling on the nodes one
 * ray may visit in the static tree. `maxNodes` of 0 means no ceiling, which is what
 * every caller but the reflection pass asks for.
 */
export const traceScene = wgslFn(
  /* wgsl */ `
	fn traceScene( ray: Ray, dynEnabled: f32, dynBounds: vec4f, maxNodes: u32 ) -> SceneHit {

		var staticHit: IntersectionResult;
		if ( maxNodes == 0u ) { staticHit = bvhIntersectFirstHit( ray ); staticHit.exhausted = false; }
		else { staticHit = bvhIntersectFirstHitBudget( ray, maxNodes ); }

		var best = staticHit;
		var isDynamic = false;

		if ( dynEnabled > 0.5 && dynBoundsHit( ray, dynBounds ) ) {
			let dynHit = dynBvhIntersectFirstHit( ray );
			if ( dynHit.didHit && ( ! staticHit.didHit || dynHit.dist < staticHit.dist ) ) {
				best = dynHit;
				isDynamic = true;
			}
		}

		var out: SceneHit;
		out.didHit = best.didHit;
		out.dist = best.dist;
		out.normal = best.normal;
		out.isDynamic = isDynamic;
		out.indices = best.indices.xyz;
		out.barycoord = best.barycoord;
		out.attrib = vec3f( 0.0 );
		// Faithful, not filtered: the ceiling can be reached AFTER something was found,
		// and the stack is not a priority queue, so a nearer triangle in a sibling
		// subtree may be the thing left unvisited. Reporting only the empty-handed case
		// would call a hit-behind-an-unseen-occluder a clean result. What to do with an
		// unreliable hit is the caller's decision.
		out.exhausted = staticHit.exhausted;

		if ( best.didHit ) {
			if ( isDynamic ) {
				out.attrib = getDynVertexAttribute( best.barycoord, best.indices.xyz );
			} else {
				out.attrib = getVertexAttribute( best.barycoord, best.indices.xyz );
			}
		}

		return out;

	}
`,
  [
    sceneHitStruct,
    bvhIntersectFirstHit,
    bvhIntersectFirstHitBudget,
    dynBvhIntersectFirstHit,
    dynBoundsHit,
    getVertexAttribute,
    getDynVertexAttribute,
    rayStruct,
    intersectionResultStruct,
    constants,
  ],
);

/**
 * Shadow rays only ever ask "is anything in the way", and a mover that cannot answer
 * yes here is a mover that casts no indirect shadow — which was half of the original
 * defect. Both structures are consulted; neither is allowed to be the only opinion.
 */
export const traceSceneOccluded = wgslFn(
  /* wgsl */ `
	fn traceSceneOccluded( ray: Ray, dynEnabled: f32, dynBounds: vec4f ) -> bool {

		if ( bvhIntersectFirstHit( ray ).didHit ) { return true; }
		if ( dynEnabled > 0.5 && dynBoundsHit( ray, dynBounds ) && dynBvhIntersectFirstHit( ray ).didHit ) { return true; }
		return false;

	}
`,
  [
    bvhIntersectFirstHit,
    dynBvhIntersectFirstHit,
    dynBoundsHit,
    rayStruct,
    intersectionResultStruct,
    constants,
  ],
);

// -----------------------------------------------------------------------------
// CPU side
// -----------------------------------------------------------------------------

export function createDynamicBVH(
  scene: THREE.Object3D,
  materialIdByUUID: Map<string, number>,
  options: { triangleBudget?: number } = {},
): DynamicBVHBundle {
  scene.updateMatrixWorld(true);
  const gathered = gatherBvhGeometries(scene, {
    materialIdByUUID, label: 'dynamic',
    include: mesh => mesh.userData.mobility === Mobility.Movable && mesh.userData.giExclude !== true,
    triangleBudget: options.triangleBudget,
  });
  return createDynamicHierarchy(scene, gathered.entries);
}
