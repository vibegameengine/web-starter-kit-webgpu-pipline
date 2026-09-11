import { wgslFn, wgsl } from 'three/tsl';

/* @important One constant used to guard the determinant, the three barycentric coordinates and the
   ray distance at once - an area, three dimensionless fractions and a length, all against 1e-5. The
   determinant cull is the one that costs light: it drops a grazing hit, the ray carries on and the
   miss is paid out as sky. Measured on the sealed room at 0.23 m/texel, where the true interior
   value is zero: the interior floor texel reads 0.00164 at 1e-5 and 0.00073 at 1e-7, while 1e-3
   changes nothing - the barycentric slack is permissive in both directions, the determinant is not.
   Split into three, each overridable: ?triDetEps= ?triBaryEps= ?triTEps=. Design section 03,
   The distance test is the one that mattered: a ray leaving a corner hits the next wall at a tiny t,
   1e-5 rejected that hit, the ray carried on out of the sealed room and the miss was paid out as
   sky. The interior texel reads 0.00164 at t=1e-5, 0.00148 at 1e-6, 0.00071 at 1e-7 and 0.00001 at
   1e-8, while the sunlit ground outside stays 0.255 throughout - nothing is being over-occluded.
   Self-intersection is the spawn offset's job, not this test's; see radiusBasedEpsilon. */
function epsilon( name, fallback ) {
	if ( typeof window === 'undefined' ) return fallback;
	const raw = new URLSearchParams( window.location.search ).get( name );
	const value = raw === null || raw === '' ? NaN : Number( raw );
	return Number.isFinite( value ) ? value : fallback;
}

export const constants = wgsl( /* wgsl */`

	const BVH_STACK_DEPTH = 60u;
	const INFINITY = 1e20;
	const TRI_DET_EPSILON = ${epsilon( 'triDetEps', 1e-12 ).toExponential()};
	const TRI_BARY_EPSILON = ${epsilon( 'triBaryEps', 1e-7 ).toExponential()};
	const TRI_T_EPSILON = ${epsilon( 'triTEps', 1e-8 ).toExponential()};

` );

export const rayStruct = wgsl( /* wgsl */`
	struct Ray {
		origin: vec3f,
		direction: vec3f,
	};
` );

export const bvhNodeBoundsStruct = wgsl( /* wgsl */`
	struct BVHBoundingBox {
		min: array<f32, 3>,
		max: array<f32, 3>,
	}
` );

export const bvhNodeStruct = wgsl( /* wgsl */`
	struct BVHNode {
		bounds: BVHBoundingBox,
		rightChildOrTriangleOffset: u32,
		splitAxisOrTriangleCount: u32,
	};
`, [ bvhNodeBoundsStruct ] );

export const intersectionResultStruct = wgsl( /* wgsl */`
	struct IntersectionResult {
		didHit: bool,
		indices: vec4u,
		normal: vec3f,
		barycoord: vec3f,
		side: f32,
		dist: f32,
		// True when a budgeted traversal stopped on its node ceiling instead of
		// finishing. 'didHit' is then false because nothing was found, not because
		// nothing is there, and a caller must not treat it as empty space.
		exhausted: bool,
	};
` );

export const getVertexAttribute = wgslFn( /* wgsl */`

	fn getVertexAttribute(
		barycoord: vec3f,
		indices: vec3u
	) -> vec3f {

		let n0 = bvh_attribute.value[ indices.x ];
		let n1 = bvh_attribute.value[ indices.y ];
		let n2 = bvh_attribute.value[ indices.z ];
		return barycoord.x * n0 + barycoord.y * n1 + barycoord.z * n2;

	}

` );

export const ndcToCameraRay = wgslFn( /* wgsl*/`

	fn ndcToCameraRay( ndc: vec2f, inverseModelViewProjection: mat4x4f ) -> Ray {

		// Calculate the ray by picking the points at the near and far plane and deriving the ray
		// direction from the two points. This approach works for both orthographic and perspective
		// camera projection matrices.
		// The returned ray direction is not normalized and extends to the camera far plane.
		var homogeneous = vec4f();
		var ray = Ray();

		homogeneous = inverseModelViewProjection * vec4f( ndc, 0.0, 1.0 );
		ray.origin = homogeneous.xyz / homogeneous.w;

		homogeneous = inverseModelViewProjection * vec4f( ndc, 1.0, 1.0 );
		ray.direction = ( homogeneous.xyz / homogeneous.w ) - ray.origin;

		return ray;

	}
` );

export const intersectsBounds = wgslFn( /* wgsl */`

	fn intersectsBounds(
		ray: Ray,
		bounds: BVHBoundingBox,
		dist: ptr<function, f32>
	) -> bool {

		let boundsMin = vec3( bounds.min[0], bounds.min[1], bounds.min[2] );
		let boundsMax = vec3( bounds.max[0], bounds.max[1], bounds.max[2] );

		let invDir = 1.0 / ray.direction;
		let tMinPlane = ( boundsMin - ray.origin ) * invDir;
		let tMaxPlane = ( boundsMax - ray.origin ) * invDir;

		let tMinHit = vec3f(
			min( tMinPlane.x, tMaxPlane.x ),
			min( tMinPlane.y, tMaxPlane.y ),
			min( tMinPlane.z, tMaxPlane.z )
		);

		let tMaxHit = vec3f(
			max( tMinPlane.x, tMaxPlane.x ),
			max( tMinPlane.y, tMaxPlane.y ),
			max( tMinPlane.z, tMaxPlane.z )
		);

		let t0 = max( max( tMinHit.x, tMinHit.y ), tMinHit.z );
		let t1 = min( min( tMaxHit.x, tMaxHit.y ), tMaxHit.z );

		( *dist ) = max( t0, 0.0 );

		return t1 >= ( *dist );

	}

`, [ rayStruct, bvhNodeBoundsStruct ] );
