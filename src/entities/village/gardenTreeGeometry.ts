import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { seededRandom } from '../../shared/lib/noise.ts';
import { instanceTransform, type PrefabPart } from '../../shared/fiber/index.ts';

type TreeSpecies = 'olive' | 'lemon';

function mergeParts(pieces: THREE.BufferGeometry[]) {
  const geometry = mergeGeometries(pieces);
  pieces.forEach(piece => piece.dispose());
  return geometry;
}

function taperedBranch(points: THREE.Vector3[], radius: number, tipRadius: number) {
  const curve = new THREE.CatmullRomCurve3(points);
  const segments = 12;
  const radial = 7;
  const geometry = new THREE.TubeGeometry(curve, segments, 1, radial, false);
  const positions = geometry.getAttribute('position');
  for (let ring = 0; ring <= segments; ring++) {
    const t = ring / segments;
    const center = curve.getPointAt(t);
    const width = THREE.MathUtils.lerp(radius, tipRadius, t ** .7);
    for (let side = 0; side <= radial; side++) {
      const index = ring * (radial + 1) + side;
      const point = new THREE.Vector3().fromBufferAttribute(positions, index);
      point.sub(center).multiplyScalar(width * (1 + .12 * Math.sin(side * 3 + ring * .55))).add(center);
      positions.setXYZ(index, point.x, point.y, point.z);
    }
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function gardenTreeParts(species: TreeSpecies, leafMaterial: THREE.Material): PrefabPart[] {
  const olive = species === 'olive';
  const random = seededRandom(olive ? 81526 : 41739);
  const wood: THREE.BufferGeometry[] = [];
  const foliage: THREE.BufferGeometry[] = [];
  const fruit: THREE.BufferGeometry[] = [];
  const roots: THREE.BufferGeometry[] = [];
  const height = olive ? 4.55 : 2.65;
  const spread = olive ? 1.25 : .78;
  const forkOrigin = new THREE.Vector3(.08, height * .43, -.06);
  const trunk = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(-.06, height * .19, .035), forkOrigin];
  wood.push(taperedBranch(trunk, olive ? .16 : .075, olive ? .075 : .036));
  for (let root = 0; root < 5; root++) {
    const angle = root * 1.256;
    roots.push(taperedBranch([new THREE.Vector3(0, .26, 0), new THREE.Vector3(Math.cos(angle) * .14, .075, Math.sin(angle) * .14), new THREE.Vector3(Math.cos(angle) * .33, .012, Math.sin(angle) * .33)], olive ? .065 : .025, .005));
  }
  const card = new THREE.PlaneGeometry(1, 1, 2, 2);
  const vertices = card.getAttribute('position');
  for (let i = 0; i < vertices.count; i++) vertices.setZ(i, .085 * Math.sin(vertices.getX(i) * Math.PI));
  card.computeVertexNormals();
  const lemon = new THREE.SphereGeometry(1, 9, 7);
  const fruitVertices = lemon.getAttribute('position');
  for (let i = 0; i < fruitVertices.count; i++) {
    const y = fruitVertices.getY(i);
    fruitVertices.setY(i, y * (1.15 + .2 * Math.abs(y) ** 5));
  }
  lemon.computeVertexNormals();
  for (let arm = 0; arm < 7; arm++) {
    const angle = arm * 2.399 + .3;
    const centralLeader = olive && arm === 6;
    const radius = spread * (centralLeader ? .26 : .65 + random() * .35);
    const crownY = height * (centralLeader ? .95 : .71 + random() * .19);
    const elbow = new THREE.Vector3(Math.cos(angle) * radius * .43, crownY * .86, Math.sin(angle) * radius * .43);
    const crown = new THREE.Vector3(Math.cos(angle) * radius, crownY, Math.sin(angle) * radius);
    wood.push(taperedBranch([forkOrigin, elbow, crown], olive ? .065 : .029, .011));
    for (let fork = 0; fork < 3; fork++) {
      const forkAngle = angle + (fork - 1) * .65;
      const tip = crown.clone().add(new THREE.Vector3(Math.cos(forkAngle) * spread * .26, .14 + random() * .27, Math.sin(forkAngle) * spread * .26));
      wood.push(taperedBranch([elbow.clone().lerp(crown, .58), crown.clone().lerp(tip, .6), tip], .014, .003));
      const leafCount = olive ? 27 : 22;
      for (let leaf = 0; leaf < leafCount; leaf++) {
        const azimuth = random() * Math.PI * 2;
        const vertical = random() * 2 - 1;
        const radius = Math.cbrt(random()) * (olive ? .46 : .36);
        const horizontal = Math.sqrt(1 - vertical * vertical) * radius;
        const center = tip.clone().add(new THREE.Vector3(Math.cos(azimuth) * horizontal, vertical * radius * .8, Math.sin(azimuth) * horizontal));
        const size = olive ? .34 + random() * .16 : .3 + random() * .12;
        const geometry = card.clone().applyMatrix4(instanceTransform(center.toArray(), [size, size, size], [(random() - .5) * 2.5, random() * Math.PI * 2, random() * Math.PI * 2]));
        const shade = .82 + random() * .18;
        const tint = new THREE.Color(shade, shade, shade * (olive ? 1 : .93));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: geometry.getAttribute('position').count }, () => tint.toArray()).flat(), 3));
        foliage.push(geometry);
        if (!olive && leaf % 8 === 0) {
          const position = center.clone().add(new THREE.Vector3(0, -.13, .04));
          const scale = .06 + random() * .025;
          const geometry = lemon.clone().applyMatrix4(instanceTransform(position.toArray(), [scale, scale, scale], [random() * .5, 0, random() * .5]));
          fruit.push(geometry);
          wood.push(taperedBranch([center, position], .004, .003));
        }
      }
    }
  }
  card.dispose();
  lemon.dispose();
  const bark = new THREE.MeshStandardNodeMaterial({ color: olive ? '#8f8772' : '#75604a', roughness: .97 });
  const parts: PrefabPart[] = [
    { id: 'tapered-branches', geometry: mergeParts(wood), material: bark },
    { id: 'root-flare', geometry: mergeParts(roots), material: bark },
    { id: 'leaf-sprays', geometry: mergeParts(foliage), material: leafMaterial },
  ];
  if (fruit.length) parts.push({ id: 'lemons', geometry: mergeParts(fruit), material: new THREE.MeshStandardNodeMaterial({ color: '#e6c52c', roughness: .62 }) });
  return parts;
}
