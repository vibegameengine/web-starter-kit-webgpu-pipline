import { wgslFn } from 'three/tsl';
import { bvhNodeStruct, intersectionResultStruct, intersectsBounds, rayStruct, constants } from './common_functions.wgsl.js';

export const intersectsTriangle = wgslFn( /* wgsl */ `

	fn intersectsTriangle( ray: Ray, a: vec3f, b: vec3f, c: vec3f ) -> IntersectionResult {

		var result: IntersectionResult;
		result.didHit = false;

		let edge1 = b - a;
		let edge2 = c - a;
		let n = cross( edge1, edge2 );

		let det = - dot( ray.direction, n );

		if ( abs( det ) < TRI_DET_EPSILON ) {

			return result;

		}

		let invdet = 1.0 / det;

		let AO = ray.origin - a;
		let DAO = cross( AO, ray.direction );

		let u = dot( edge2, DAO ) * invdet;
		let v = -dot( edge1, DAO ) * invdet;
		let t = dot( AO, n ) * invdet;

		let w = 1.0 - u - v;

		if ( u < - TRI_BARY_EPSILON || v < - TRI_BARY_EPSILON || w < - TRI_BARY_EPSILON || t < TRI_T_EPSILON ) {

			return result;

		}

		result.didHit = true;
		result.barycoord = vec3f( w, u, v );
		result.dist = t;
		result.side = sign( det );
		result.normal = result.side * normalize( n );

		return result;

	}

`, [ rayStruct, intersectionResultStruct, constants ] );

export const intersectTriangles = wgslFn( /* wgsl */ `

	fn intersectTriangles(
		offset: u32,
		count: u32,
		ray: Ray
	) -> IntersectionResult {

		var closestResult: IntersectionResult;

		closestResult.didHit = false;
		closestResult.dist = INFINITY;

		for ( var i = offset; i < offset + count; i = i + 1u ) {

			let indices = bvh_index.value[ i ];
			let a = bvh_position.value[ indices.x ];
			let b = bvh_position.value[ indices.y ];
			let c = bvh_position.value[ indices.z ];

			var triResult = intersectsTriangle( ray, a, b, c );

			if ( triResult.didHit && triResult.dist < closestResult.dist ) {

				closestResult = triResult;
				closestResult.indices = vec4u( indices.xyz, i );

			}

		}

		return closestResult;

	}

`, [ intersectsTriangle, rayStruct, intersectionResultStruct, constants ] );

/**
 * Closest hit, with a ceiling on how many nodes one ray may visit.
 *
 * The traversal cost of a ray is unbounded: a ray grazing dense geometry pops far
 * more nodes than one that hits a wall. Measured on the beach 2026-09-09, the
 * reflection pass ran at 3.18 ms on a median frame and 7.75 / 9.73 / 10.76 ms on
 * three frames out of 506 — the same rays, the same budget, a different set of
 * random directions. A node ceiling turns that tail into a fixed worst case.
 *
 * A ray that exhausts its budget returns whatever it had found so far, which for a
 * reflection means the environment rather than a geometry hit. That is a real
 * change to those rays, so the budget belongs to the caller, not in here.
 */
export const bvhIntersectFirstHitBudget = wgslFn( /* wgsl */ `

	fn bvhIntersectFirstHitBudget(
		ray: Ray,
		maxNodes: u32
	) -> IntersectionResult {

		var pointer = 0;
		var visited = 0u;
		var stack: array<u32, BVH_STACK_DEPTH>;
		stack[ 0 ] = 0u;

		var bestHit: IntersectionResult;

		bestHit.didHit = false;
		bestHit.dist = INFINITY;
		bestHit.exhausted = false;

		loop {

			if ( pointer < 0 || pointer >= i32( BVH_STACK_DEPTH ) ) { break; }
			if ( visited >= maxNodes ) { bestHit.exhausted = true; break; }

			let currNodeIndex = stack[ pointer ];
			let node = bvh.value[ currNodeIndex ];

			pointer = pointer - 1;

			var boundsHitDistance: f32 = 0.0;

			// A node culled by its bounds is not a visit: it costs one box test, not the
			// descent the ceiling is meant to bound. Counting it made the real budget an
			// unknown fraction of the number asked for.
			if ( ! intersectsBounds( ray, node.bounds, &boundsHitDistance ) || boundsHitDistance > bestHit.dist ) { continue; }

			visited = visited + 1u;

			let boundsInfox = node.splitAxisOrTriangleCount;
			let boundsInfoy = node.rightChildOrTriangleOffset;

			let isLeaf = ( boundsInfox & 0xffff0000u ) != 0u;

			if ( isLeaf ) {

				let localHit = intersectTriangles( boundsInfoy, boundsInfox & 0x0000ffffu, ray );
				// Field by field, not a whole-struct assignment: intersectTriangles never sets
				// the exhausted flag, so copying its result over bestHit would erase a ceiling that
				// had already been reached. Today WGSL zero-initialises it and the two agree
				// by luck; this does not depend on that.
				if ( localHit.didHit && localHit.dist < bestHit.dist ) {
					let wasExhausted = bestHit.exhausted;
					bestHit = localHit;
					bestHit.exhausted = wasExhausted;
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

`, [ intersectTriangles, intersectsBounds, rayStruct, bvhNodeStruct, intersectionResultStruct, constants ] );

export const bvhIntersectFirstHit = wgslFn( /* wgsl */ `

	fn bvhIntersectFirstHit(
		ray: Ray
	) -> IntersectionResult {

		var pointer = 0;
		var stack: array<u32, BVH_STACK_DEPTH>;
		stack[ 0 ] = 0u;

		var bestHit: IntersectionResult;

		bestHit.didHit = false;
		bestHit.dist = INFINITY;

		loop {

			if ( pointer < 0 || pointer >= i32( BVH_STACK_DEPTH ) ) {

				break;

			}

			let currNodeIndex = stack[ pointer ];
			let node = bvh.value[ currNodeIndex ];

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

				let localHit = intersectTriangles(
					offset, count, ray
				);

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

`, [ intersectTriangles, intersectsBounds, rayStruct, bvhNodeStruct, intersectionResultStruct, constants ] );
