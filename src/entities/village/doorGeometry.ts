import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const ARCHED_DOOR = { halfWidth: .32, spring: 1.24, foot: .035, scale: 1.3 };

export function usesArchedEntry(id: string) {
  return id === 'yellow-house' || id === 'coral-house';
}

export function doorwayContour(halfWidth = ARCHED_DOOR.halfWidth): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth, ARCHED_DOOR.foot);
  shape.lineTo(halfWidth, ARCHED_DOOR.foot);
  shape.lineTo(halfWidth, ARCHED_DOOR.spring);
  shape.absarc(0, ARCHED_DOOR.spring, halfWidth, 0, Math.PI, false);
  shape.lineTo(-halfWidth, ARCHED_DOOR.foot);
  shape.closePath();
  return shape;
}

export function archedDoorLeaf() {
  return new THREE.ExtrudeGeometry(doorwayContour(.312), { depth: .075, bevelEnabled: false, curveSegments: 16 }).translate(0, 0, -.2425);
}

export function archedDoorSurround() {
  const pieces: THREE.BufferGeometry[] = [];
  const outer = .44;
  const inner = ARCHED_DOOR.halfWidth;
  for (let stone = 0; stone < 9; stone++) {
    const a0 = stone * Math.PI / 9 + .013;
    const a1 = (stone + 1) * Math.PI / 9 - .013;
    const outerRadius = stone === 4 ? outer + .035 : outer;
    const shape = new THREE.Shape();
    shape.moveTo(Math.cos(a0) * outerRadius, ARCHED_DOOR.spring + Math.sin(a0) * outerRadius);
    shape.absarc(0, ARCHED_DOOR.spring, outerRadius, a0, a1, false);
    shape.lineTo(Math.cos(a1) * inner, ARCHED_DOOR.spring + Math.sin(a1) * inner);
    shape.absarc(0, ARCHED_DOOR.spring, inner, a1, a0, true);
    shape.closePath();
    pieces.push(new THREE.ExtrudeGeometry(shape, { depth: .16, bevelEnabled: true, bevelSize: .006, bevelThickness: .004, bevelSegments: 1, curveSegments: 12 }).translate(0, 0, -.055));
  }
  const height = (ARCHED_DOOR.spring - .035) / 5;
  for (const side of [-1, 1]) for (let row = 0; row < 5; row++) {
    pieces.push(new THREE.BoxGeometry(outer - inner, height - .01, .16).toNonIndexed().translate(side * (inner + outer) / 2, .035 + (row + .5) * height, .025));
  }
  pieces.push(new THREE.BoxGeometry(.91, .05, .36).toNonIndexed().translate(0, .025, .08));
  const geometry = mergeGeometries(pieces);
  pieces.forEach(piece => piece.dispose());
  return geometry;
}
