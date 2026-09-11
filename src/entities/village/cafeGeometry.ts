import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function cafeJoin(pieces: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geometry = mergeGeometries(pieces);
  pieces.forEach(piece => piece.dispose());
  return geometry;
}

export function cafeBeam(start: number[], end: number[], width: number, depth = width): THREE.BufferGeometry {
  const a = new THREE.Vector3().fromArray(start);
  const b = new THREE.Vector3().fromArray(end);
  const direction = b.clone().sub(a);
  return new THREE.BoxGeometry(width, direction.length(), depth)
    .applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()))
    .translate(...a.add(b).multiplyScalar(.5).toArray() as [number, number, number]);
}

export function cafeCanopyPoint(angle: number, radius: number): THREE.Vector3 {
  const panelPhase = ((angle / (Math.PI * 2) * 8) % 1 + 1) % 1;
  const sag = Math.sin(panelPhase * Math.PI) * .075 * radius;
  return new THREE.Vector3(Math.cos(angle) * radius, 2.28 - .33 * radius - .1 * radius * radius - sag, Math.sin(angle) * radius);
}

export function cafeCanopy(): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const rings = 6;
  const segments = 64;
  for (let ring = 0; ring <= rings; ring++) {
    const radius = ring / rings * 1.16;
    for (let i = 0; i <= segments; i++) {
      const angle = i / segments * Math.PI * 2;
      const point = cafeCanopyPoint(angle, radius);
      positions.push(point.x, point.y, point.z);
      uvs.push(.5 + point.x / 2.32, .5 + point.z / 2.32);
      if (ring < rings && i < segments) {
        const vertex = ring * (segments + 1) + i;
        indices.push(vertex, vertex + 1, vertex + segments + 1, vertex + 1, vertex + segments + 2, vertex + segments + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export function cafeScallopedValance(width: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, 0);
  shape.lineTo(width / 2, 0);
  shape.lineTo(width / 2, -.09);
  const scallops = 8;
  for (let i = 0; i < scallops; i++) {
    const right = width / 2 - i * width / scallops;
    const left = right - width / scallops;
    shape.quadraticCurveTo((left + right) / 2, -.2, left, -.09);
  }
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth: .012, bevelEnabled: false, curveSegments: 4 });
}
