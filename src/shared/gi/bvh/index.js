// Harvested from jure/webgiya's vendored three-mesh-bvh — the copy proven against
// three r182. Trimmed to the CPU BVH builder plus the WGSL traversal the GI cache
// needs: no workers, no WebGL path, no debug helpers, no BVHHelper.
//
// Why not the npm package: three-mesh-bvh@0.9.12's WebGPU module moved to
// StructTypeNode and pointer-parameter WGSL, and states it requires three r185+.
export * from './core/BVH.js';
export * from './core/MeshBVH.js';
export * from './core/LineBVH.js';
export * from './core/PointsBVH.js';
export {
  CENTER,
  AVERAGE,
  SAH,
  NOT_INTERSECTED,
  INTERSECTED,
  CONTAINED,
} from './core/Constants.js';
export * from './utils/ExtensionUtilities.js';
export { getTriangleHitPointInfo } from './utils/TriangleUtilities.js';
export * from './math/ExtendedTriangle.js';
export * from './math/OrientedBox.js';
export * from './utils/StaticGeometryGenerator.js';
