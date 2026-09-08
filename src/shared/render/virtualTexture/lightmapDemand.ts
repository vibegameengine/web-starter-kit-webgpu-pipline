import * as THREE from 'three/webgpu';
import { Layer } from '../../world/index.ts';
import type { LightmapPageSource } from './lightmapPages.ts';
import type { PageDemand } from './virtualLightmap.ts';
import { footprintWidth } from './filterFootprint';

interface Surface {
  vertices: THREE.Vector3[];
  normal: THREE.Vector3;
  bounds: THREE.Sphere;
  uvMin: THREE.Vector2;
  uvMax: THREE.Vector2;
  uvArea: number;
  uvs: THREE.Vector2[];
}

/** Coarse CPU demand from static triangles. No synchronous framebuffer readback.
 * Occluded triangles may request extra pages; the GPU budget is still bounded. */
export function createLightmapDemand(scene: THREE.Scene, source: LightmapPageSource) {
  const surfaces: Surface[] = [];
  scene.updateMatrixWorld(true);
  scene.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.layers.isEnabled(Layer.GiStatic) || !mesh.visible) return;
    const uv = mesh.geometry.getAttribute('uv1'), position = mesh.geometry.getAttribute('position'), index = mesh.geometry.index;
    if (!uv) return;
    for (let i = 0; i < (index?.count ?? position.count); i += 3) {
      const ids = [0, 1, 2].map(j => index ? index.getX(i + j) : i + j);
      const vertices = ids.map(id => new THREE.Vector3().fromBufferAttribute(position, id).applyMatrix4(mesh.matrixWorld));
      const uvs = ids.map(id => new THREE.Vector2(uv.getX(id), uv.getY(id)));
      const uvArea = Math.abs((uvs[1].x - uvs[0].x) * (uvs[2].y - uvs[0].y) - (uvs[1].y - uvs[0].y) * (uvs[2].x - uvs[0].x)) * .5;
      if (uvArea < 1e-12) continue;
      const center = vertices[0].clone().add(vertices[1]).add(vertices[2]).multiplyScalar(1 / 3);
      surfaces.push({ vertices,
        normal: vertices[1].clone().sub(vertices[0]).cross(vertices[2].clone().sub(vertices[0])).normalize(),
        bounds: new THREE.Sphere(center, Math.max(...vertices.map(v => v.distanceTo(center)))),
        uvMin: uvs[0].clone().min(uvs[1]).min(uvs[2]), uvMax: uvs[0].clone().max(uvs[1]).max(uvs[2]), uvArea, uvs });
    }
  });
  const frustum = new THREE.Frustum(), matrix = new THREE.Matrix4();
  return (camera: THREE.PerspectiveCamera, width: number, height: number, anisotropy = 8): PageDemand[] => {
    matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(matrix, camera.coordinateSystem);
    const requests: PageDemand[] = [];
    for (const surface of surfaces) {
      if (!frustum.intersectsSphere(surface.bounds) || surface.normal.dot(camera.position.clone().sub(surface.bounds.center)) <= 0) continue;
      const clip = surface.vertices.map(v => new THREE.Vector4(v.x, v.y, v.z, 1).applyMatrix4(matrix));
      const p = clip.map(v => new THREE.Vector3(v.x / v.w, v.y / v.w, v.z / v.w));
      const pixelArea = Math.min(width * height, Math.abs((p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[1].y - p[0].y) * (p[2].x - p[0].x)) * width * height / 8);
      if (!Number.isFinite(pixelArea) || pixelArea < 1) continue;
      // Perspective-correct UV gradients at the projected triangle centroid.
      // Demand remains coarse (visibility is not read back), but its mip width
      // follows the raster filter's minor axis and anisotropy cap.
      const sx1 = (p[1].x - p[0].x) * width * .5, sx2 = (p[2].x - p[0].x) * width * .5;
      const sy1 = (p[1].y - p[0].y) * height * .5, sy2 = (p[2].y - p[0].y) * height * .5;
      const determinant = sx1 * sy2 - sx2 * sy1;
      let filterWidth = 1;
      if (Math.abs(determinant) > 1e-9 && clip.every(v => v.w > 1e-6)) {
        const inverseW = clip.map(v => 1 / v.w);
        const reciprocal = (inverseW[0] + inverseW[1] + inverseW[2]) / 3;
        const gradient = (values: number[]) => [
          ((values[1] - values[0]) * sy2 - (values[2] - values[0]) * sy1) / determinant,
          (sx1 * (values[2] - values[0]) - sx2 * (values[1] - values[0])) / determinant,
        ];
        const dr = gradient(inverseW), duv = ['x', 'y'].map(axis => {
          const values = surface.uvs.map((uv, i) => uv[axis as 'x' | 'y'] * inverseW[i]);
          const centre = (values[0] + values[1] + values[2]) / (3 * reciprocal), dq = gradient(values);
          return dq.map((value, i) => (value - centre * dr[i]) / reciprocal * source.size);
        });
        filterWidth = footprintWidth([duv[0][0], duv[1][0]], [duv[0][1], duv[1][1]], anisotropy);
      }
      const lod = Math.min(source.fallbackMip, Math.log2(filterWidth));
      // Request both trilinear levels. Coarser parents get priority because one
      // parent makes many fine-page misses acceptable while detail arrives.
      for (let mip = source.fallbackMip - 1; mip >= Math.floor(lod); mip--) {
        const pages = source.size / 2 ** mip / source.pageSize;
        const minX = Math.max(0, Math.floor(surface.uvMin.x * pages)), minY = Math.max(0, Math.floor(surface.uvMin.y * pages));
        const maxX = Math.min(pages - 1, Math.floor(surface.uvMax.x * pages)), maxY = Math.min(pages - 1, Math.floor(surface.uvMax.y * pages));
        for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) requests.push({ key: { mip, x, y }, priority: pixelArea * 2 ** mip });
      }
    }
    return requests;
  };
}
