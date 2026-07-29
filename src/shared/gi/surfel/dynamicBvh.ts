// @ts-nocheck -- shares vendored webgiya conventions (storage-node naming, wgslFn
// dependency lists) with sceneBvh.ts / surfelIntegratePass.ts, so it is written in the
// same style even though it has no upstream counterpart.
import * as THREE from 'three/webgpu';
import { CENTER, MeshBVH } from '../bvh/index.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { storage, uniform, wgsl, wgslFn } from 'three/tsl';
import {
  bvhIntersectFirstHit,
  bvhNodeStruct,
  constants,
  getVertexAttribute,
  intersectionResultStruct,
  intersectsBounds,
  intersectsTriangle,
  rayStruct,
} from '../bvh/webgpu/index.js';
import { Mobility } from '../../world/index.ts';
import { gatherBvhGeometries, type GatheredGeometry } from './sceneBvh';

/**
 * A second acceleration structure, over `Mobility.Movable` geometry only.
 *
 * Why two structures rather than one rebuilt per frame: the static half is the forest —
 * hundreds of thousands of triangles whose SAH build is measured in seconds. Lumen gets
 * away with rebuilding its TLAS every frame because the TLAS is a handful of instance
 * boxes over prebuilt BLASes; we have no TLAS, so the equivalent trade is to keep the
 * expensive structure built once and pay only for the handful of triangles that moved.
 *
 * The buffers are allocated once and never resized. A `StorageBufferAttribute` that is
 * already bound into a compiled pipeline cannot grow — swapping its array would leave
 * the GPU holding a buffer of the old size — so the mover *set* is fixed at creation
 * and only its matrices are allowed to change. Adding a mover later is refused loudly
 * rather than half-applied.
 */
export type DynamicBVHBundle = {
  // TSL Storage Nodes, named apart from the static set so both can be bound at once.
  bvhNode: THREE.StorageBufferNode;
  positionNode: THREE.StorageBufferNode;
  normalNode: THREE.StorageBufferNode;
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
  /** Rebuilds if any mover's world matrix changed. Returns true if it did. */
  refresh: (options?: { force?: boolean }) => boolean;
  /** Wall-clock cost of the last rebuild, in ms. 0 if none has happened. */
  lastRebuildMs: number;
};

/**
 * Rebuilding is gated on movement, so it is worth knowing when it fires. Off by
 * default because a per-frame log is how a console becomes useless.
 */
export const DYNAMIC_BVH_LOG = false;

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

export const dynBvhIntersectFirstHit = wgslFn(
  /* wgsl */ `

	fn dynBvhIntersectFirstHit(
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

export const traceScene = wgslFn(
  /* wgsl */ `
	fn traceScene( ray: Ray, dynEnabled: f32, dynBounds: vec4f ) -> SceneHit {

		let staticHit = bvhIntersectFirstHit( ray );

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
		out.attrib = vec3f( 0.0 );

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

/** A degenerate triangle, so an empty structure still binds a legal buffer. */
function emptyGeometry(): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(9), 3),
  );
  geom.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
  geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(9), 3));
  geom.setIndex([0, 1, 2]);
  return geom;
}

const _normalMatrix = new THREE.Matrix3();

/**
 * Writes one entry's world-space positions and normals into the shared arrays.
 *
 * This exists instead of `template.clone().applyMatrix4(m)` because refresh runs in the
 * animation loop: cloning a geometry per mover per frame is how a "small dynamic BVH"
 * turns into a garbage-collection stutter.
 */
function bakeEntry(
  entry: GatheredGeometry,
  positions: Float32Array,
  normals: Float32Array,
  vertexOffset: number,
): number {
  const srcPos = entry.template.getAttribute('position').array as Float32Array;
  const srcNor = entry.template.getAttribute('normal').array as Float32Array;
  const count = entry.template.getAttribute('position').count;

  const m = entry.matrix.elements;
  _normalMatrix.getNormalMatrix(entry.matrix);
  const n = _normalMatrix.elements;

  for (let i = 0; i < count; i++) {
    const s = i * 3;
    const d = (vertexOffset + i) * 3;

    const x = srcPos[s];
    const y = srcPos[s + 1];
    const z = srcPos[s + 2];
    const w = 1 / (m[3] * x + m[7] * y + m[11] * z + m[15] || 1);
    positions[d] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * w;
    positions[d + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * w;
    positions[d + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * w;

    const nx = srcNor[s];
    const ny = srcNor[s + 1];
    const nz = srcNor[s + 2];
    let ox = n[0] * nx + n[3] * ny + n[6] * nz;
    let oy = n[1] * nx + n[4] * ny + n[7] * nz;
    let oz = n[2] * nx + n[5] * ny + n[8] * nz;
    const len = Math.hypot(ox, oy, oz) || 1;
    ox /= len;
    oy /= len;
    oz /= len;
    normals[d] = ox;
    normals[d + 1] = oy;
    normals[d + 2] = oz;
  }

  return vertexOffset + count;
}

export function createDynamicBVH(
  scene: THREE.Object3D,
  materialIdByUUID: Map<string, number>,
  options: { triangleBudget?: number } = {},
): DynamicBVHBundle {
  scene.updateMatrixWorld(true);

  const gathered = gatherBvhGeometries(scene, {
    materialIdByUUID,
    label: 'dynamic',
    include: (mesh) => mesh.userData.mobility === Mobility.Movable,
    triangleBudget: options.triangleBudget,
  });

  const entries = gathered.entries;
  const hasMovers = entries.length > 0;

  // A structure is still built and bound when nothing moves, because the alternative is
  // two shader variants. One variant, switched off by a uniform, is cheaper to reason
  // about than two that can drift apart.
  const merged = hasMovers
    ? BufferGeometryUtils.mergeGeometries(
        entries.map((entry) => entry.template.clone().applyMatrix4(entry.matrix)),
      )
    : emptyGeometry();

  const positions = merged.getAttribute('position').array as Float32Array;
  const normals = merged.getAttribute('normal').array as Float32Array;
  const colors = merged.getAttribute('color').array as Float32Array;
  const vertexCount = merged.getAttribute('position').count;
  const triangleCount = merged.index.count / 3;

  const buildStart = performance.now();
  let bvh = new MeshBVH(merged, { maxLeafTris: 1, strategy: CENTER });
  const buildMs = performance.now() - buildStart;

  // CENTER, not SAH: this build is on the frame budget. SAH costs several times more to
  // construct for a traversal win that is worth having exactly once, which is the static
  // structure's situation and not this one's.
  console.log(
    `[BVH:dynamic] ${entries.length} mover copies, ${triangleCount} triangles, ` +
      `built in ${buildMs.toFixed(2)}ms`,
  );

  const nodeFloats = new Float32Array(bvh._roots[0]);

  // Headroom on the node array only. Vertex and index counts are fixed by the mover set
  // and never move; node counts can wobble by a few when a split degenerates, and a
  // rebuild that overflows would otherwise have to resize a bound buffer — which is not
  // a thing that can be done.
  const nodeCapacity = Math.max(64, Math.ceil(nodeFloats.length * 1.5));
  const nodeArray = new Float32Array(nodeCapacity);
  nodeArray.set(nodeFloats);

  const bvhAttr = new THREE.StorageBufferAttribute(nodeArray, 8);
  const posAttr = new THREE.StorageBufferAttribute(new Float32Array(positions), 3);
  const norAttr = new THREE.StorageBufferAttribute(new Float32Array(normals), 3);
  const colAttr = new THREE.StorageBufferAttribute(new Float32Array(colors), 3);
  const idxAttr = new THREE.StorageBufferAttribute(
    new Uint32Array(merged.index.array),
    3,
  );

  const bvhNode = storage(bvhAttr, 'BVHNode', bvhAttr.count)
    .toReadOnly()
    .setName('dyn_bvh');
  const positionNode = storage(posAttr, 'vec3', posAttr.count)
    .toReadOnly()
    .setName('dyn_bvh_position');
  const normalNode = storage(norAttr, 'vec3', norAttr.count)
    .toReadOnly()
    .setName('dyn_bvh_normal');
  const indexNode = storage(idxAttr, 'uvec3', idxAttr.count)
    .toReadOnly()
    .setName('dyn_bvh_index');
  const colorNode = storage(colAttr, 'vec3', colAttr.count)
    .toReadOnly()
    .setName('dyn_bvh_attribute');

  const enabled = uniform(hasMovers ? 1 : 0);
  const influence = uniform(new THREE.Vector4(0, 0, 0, 0));

  // Scratch used by refresh: the merged geometry is rebuilt in place, never reallocated.
  const workPositions = positions;
  const workNormals = normals;
  const lastMatrices = entries.map((entry) => entry.matrix.clone());
  const scratchMatrix = new THREE.Matrix4();

  const updateInfluence = () => {
    if (!hasMovers) {
      influence.value.set(0, 0, 0, 0);
      return;
    }
    merged.computeBoundingSphere();
    const s = merged.boundingSphere;
    influence.value.set(s.center.x, s.center.y, s.center.z, s.radius);
  };

  const bundle: DynamicBVHBundle = {
    bvhNode,
    positionNode,
    normalNode,
    indexNode,
    colorNode,
    enabled,
    influence,
    triangleCount,
    moverCount: entries.length,
    lastRebuildMs: 0,
    refresh(refreshOptions = {}) {
      if (!hasMovers) return false;

      scene.updateMatrixWorld(false);

      let moved = refreshOptions.force === true;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const source = entry.source;
        if (entry.instance >= 0) {
          (source as THREE.InstancedMesh).getMatrixAt(entry.instance, scratchMatrix);
          scratchMatrix.premultiply(source.matrixWorld);
        } else {
          scratchMatrix.copy(source.matrixWorld);
        }
        if (!moved && !scratchMatrix.equals(lastMatrices[i])) moved = true;
        entry.matrix.copy(scratchMatrix);
        lastMatrices[i].copy(scratchMatrix);
      }

      // The gate is the point of the whole design: a scene where nothing moved pays
      // one matrix comparison per mover and no rebuild at all.
      if (!moved) return false;

      const start = performance.now();

      let offset = 0;
      for (const entry of entries) {
        offset = bakeEntry(entry, workPositions, workNormals, offset);
      }
      merged.getAttribute('position').needsUpdate = true;
      merged.getAttribute('normal').needsUpdate = true;
      merged.boundingBox = null;
      merged.boundingSphere = null;

      bvh = new MeshBVH(merged, { maxLeafTris: 1, strategy: CENTER });
      const roots = new Float32Array(bvh._roots[0]);

      if (roots.length > nodeCapacity) {
        console.error(
          `[BVH:dynamic] rebuild produced ${roots.length / 8} nodes, past the ` +
            `${nodeCapacity / 8} allocated at creation. The bound buffer cannot grow, so ` +
            'the PREVIOUS pose is still what the tracer sees. Movable geometry is now ' +
            'lagging the raster by one or more frames.',
        );
        return false;
      }

      (bvhAttr.array as Float32Array).fill(0);
      (bvhAttr.array as Float32Array).set(roots);
      bvhAttr.needsUpdate = true;

      (posAttr.array as Float32Array).set(workPositions);
      posAttr.needsUpdate = true;
      (norAttr.array as Float32Array).set(workNormals);
      norAttr.needsUpdate = true;

      // The index is re-ordered by every build (that is what a build *is*), so it has to
      // travel with the nodes. Colours never do: matId is a property of the triangle,
      // not of where the triangle currently sits.
      (idxAttr.array as Uint32Array).set(merged.index.array as Uint32Array);
      idxAttr.needsUpdate = true;

      updateInfluence();

      bundle.lastRebuildMs = performance.now() - start;
      if (DYNAMIC_BVH_LOG) {
        console.log(
          `[BVH:dynamic] rebuilt ${triangleCount} triangles in ` +
            `${bundle.lastRebuildMs.toFixed(2)}ms`,
        );
      }
      return true;
    },
  };

  updateInfluence();
  return bundle;
}
