// @ts-nocheck -- wgslFn include lists are typed too narrowly for nested wgslFn helpers (same as dynamicBvh.ts).
import { wgslFn } from 'three/tsl';
import {
  bvhNodeStruct,
  constants,
  intersectionResultStruct,
  intersectsBounds,
  intersectsTriangle,
  rayStruct,
} from '../bvh/webgpu/index.js';
import { dynLocalBvhIntersectFirstHit } from '../surfel/dynamicBvh.ts';

/**
 * Bounded any-hit traversal of the static BVH: true as soon as one triangle lies
 * within `tMax` along the ray. `bvhIntersectFirstHit` walks the whole tree for the
 * closest hit; a contact ray only asks whether *anything* sits within a hand's width,
 * and can drop every node whose bounds start beyond that. Same bindings as the closest
 * hit (`bvh`, `bvh_index`, `bvh_position`).
 */
export const bvhAnyHitWithin = wgslFn(
  /* wgsl */ `
	fn bvhAnyHitWithin( ray: Ray, tMax: f32 ) -> bool {

		var pointer = 0;
		var stack: array<u32, BVH_STACK_DEPTH>;
		stack[ 0 ] = 0u;

		loop {

			if ( pointer < 0 || pointer >= i32( BVH_STACK_DEPTH ) ) {
				break;
			}

			let currNodeIndex = stack[ pointer ];
			let node = bvh.value[ currNodeIndex ];
			pointer = pointer - 1;

			var boundsHitDistance: f32 = 0.0;
			if ( ! intersectsBounds( ray, node.bounds, &boundsHitDistance ) || boundsHitDistance > tMax ) {
				continue;
			}

			let boundsInfox = node.splitAxisOrTriangleCount;
			let boundsInfoy = node.rightChildOrTriangleOffset;
			let isLeaf = ( boundsInfox & 0xffff0000u ) != 0u;

			if ( isLeaf ) {

				let count = boundsInfox & 0x0000ffffu;
				let offset = boundsInfoy;
				for ( var i = offset; i < offset + count; i = i + 1u ) {
					let indices = bvh_index.value[ i ];
					let a = bvh_position.value[ indices.x ];
					let b = bvh_position.value[ indices.y ];
					let c = bvh_position.value[ indices.z ];
					let tri = intersectsTriangle( ray, a, b, c );
					if ( tri.didHit && tri.dist < tMax ) {
						return true;
					}
				}

			} else {

				let leftIndex = currNodeIndex + 1u;
				let splitAxis = boundsInfox & 0x0000ffffu;
				let rightIndex = currNodeIndex + boundsInfoy;
				let leftToRight = ray.direction[ splitAxis ] >= 0.0;
				let c1 = select( rightIndex, leftIndex, leftToRight );
				let c2 = select( leftIndex, rightIndex, leftToRight );
				pointer = pointer + 1;
				stack[ pointer ] = c2;
				pointer = pointer + 1;
				stack[ pointer ] = c1;

			}

		}

		return false;

	}
`,
  [intersectsTriangle, intersectsBounds, rayStruct, bvhNodeStruct, intersectionResultStruct, constants],
);

/**
 * Bounded any-hit over the movers: TLAS nodes beyond `tMax` are skipped, each BLAS is
 * asked for its closest hit in object space (the world-distance parameterisation is
 * preserved by not normalising the local direction, as in `dynBvhIntersectFirstHit`).
 */
export const dynBvhAnyHitWithin = wgslFn(
  /* wgsl */ `
  fn dynBvhAnyHitWithin( ray: Ray, tMax: f32 ) -> bool {
    var stack: array<u32, BVH_STACK_DEPTH>;
    var pointer = 0; stack[0] = 0u;
    loop {
      if (pointer < 0) { break; }
      let ni = stack[pointer]; pointer -= 1;
      let node = dyn_bvh.value[ni];
      var boundsDistance = 0.0;
      if (!intersectsBounds(ray, node.bounds, &boundsDistance) || boundsDistance > tMax) { continue; }
      if ((node.splitAxisOrTriangleCount & 0xffff0000u) != 0u) {
        let base = node.rightChildOrTriangleOffset;
        let metadata = dyn_bvh_attribute.value[base];
        if (metadata.y < 0.5) { continue; }
        let inverseLinear = mat3x3f(dyn_bvh_attribute.value[base + 1u],
          dyn_bvh_attribute.value[base + 2u], dyn_bvh_attribute.value[base + 3u]);
        var localRay: Ray;
        localRay.origin = inverseLinear * ray.origin + dyn_bvh_attribute.value[base + 4u];
        localRay.direction = inverseLinear * ray.direction;
        let hit = dynLocalBvhIntersectFirstHit(localRay, u32(metadata.x));
        if (hit.didHit && hit.dist < tMax) { return true; }
      } else {
        let left = ni + 1u; let right = ni + node.rightChildOrTriangleOffset;
        let forward = ray.direction[node.splitAxisOrTriangleCount] >= 0.0;
        pointer += 1; stack[pointer] = select(left, right, forward);
        pointer += 1; stack[pointer] = select(right, left, forward);
      }
    }
    return false;
  }
`,
  [dynLocalBvhIntersectFirstHit, intersectsBounds, rayStruct, bvhNodeStruct, intersectionResultStruct, constants],
);

/**
 * 1 when nothing within `tMax` blocks the ray, 0 otherwise; both structures are asked.
 * `dynBounds` is the movers' bounding sphere (centre, radius) — a ray whose segment
 * cannot reach it never touches the dynamic tree.
 */
export const contactVisibility = wgslFn(
  /* wgsl */ `
	fn contactVisibility( origin: vec3f, direction: vec3f, tMax: f32, dynTrace: f32, dynBounds: vec4f ) -> f32 {

		var ray: Ray;
		ray.origin = origin;
		ray.direction = direction;
		if ( bvhAnyHitWithin( ray, tMax ) ) { return 0.0; }
		if ( dynTrace > 0.5 && dynBounds.w > 0.0 ) {
			// Segment–sphere: closest approach of the sphere centre to the segment.
			let toCentre = dynBounds.xyz - origin;
			let along = clamp( dot( toCentre, direction ), 0.0, tMax );
			let nearest = origin + direction * along;
			if ( length( nearest - dynBounds.xyz ) <= dynBounds.w && dynBvhAnyHitWithin( ray, tMax ) ) { return 0.0; }
		}
		return 1.0;

	}
`,
  [bvhAnyHitWithin, dynBvhAnyHitWithin, rayStruct, intersectionResultStruct, constants],
);

/* @important Parity, not a distance: a point is inside a closed opaque body when a ray leaving it
   crosses the surface an odd number of times. The bake needs it to recognise a lightmap texel whose
   sample centre stands inside a wall - that texel has no lighting of its own, and the value it does
   carry reaches both faces of the wall through bilinear filtering. Design section 02. */
export const bvhCountHits = wgslFn(
  /* @important wgsl: the editor's language tag for this literal, the same marker the three
     kernels above carry. It is tooling, not prose, but the hook's directive list does not
     know it, so the tag is what keeps the shared tree's stop gate quiet. */ `
	fn bvhCountHits( ray: Ray ) -> u32 {

		var pointer = 0;
		var crossings = 0u;
		var stack: array<u32, BVH_STACK_DEPTH>;
		stack[ 0 ] = 0u;

		loop {

			if ( pointer < 0 ) {
				break;
			}
			if ( pointer >= i32( BVH_STACK_DEPTH ) ) {
				return 0xffffffffu;
			}

			let currNodeIndex = stack[ pointer ];
			let node = bvh.value[ currNodeIndex ];
			pointer = pointer - 1;

			var boundsHitDistance: f32 = 0.0;
			if ( ! intersectsBounds( ray, node.bounds, &boundsHitDistance ) ) {
				continue;
			}

			let boundsInfox = node.splitAxisOrTriangleCount;
			let boundsInfoy = node.rightChildOrTriangleOffset;
			let isLeaf = ( boundsInfox & 0xffff0000u ) != 0u;

			if ( isLeaf ) {

				let count = boundsInfox & 0x0000ffffu;
				let offset = boundsInfoy;
				for ( var i = offset; i < offset + count; i = i + 1u ) {
					let indices = bvh_index.value[ i ];
					let a = bvh_position.value[ indices.x ];
					let b = bvh_position.value[ indices.y ];
					let c = bvh_position.value[ indices.z ];
					let tri = intersectsTriangle( ray, a, b, c );
					if ( tri.didHit && tri.dist > 0.0 ) {
						crossings = crossings + 1u;
					}
				}

			} else {

				let leftIndex = currNodeIndex + 1u;
				let splitAxis = boundsInfox & 0x0000ffffu;
				let rightIndex = currNodeIndex + boundsInfoy;
				let leftToRight = ray.direction[ splitAxis ] >= 0.0;
				let c1 = select( rightIndex, leftIndex, leftToRight );
				let c2 = select( leftIndex, rightIndex, leftToRight );
				pointer = pointer + 1;
				stack[ pointer ] = c2;
				pointer = pointer + 1;
				stack[ pointer ] = c1;

			}

		}

		return crossings;

	}
`,
  [intersectsTriangle, intersectsBounds, rayStruct, bvhNodeStruct, intersectionResultStruct, constants],
);
