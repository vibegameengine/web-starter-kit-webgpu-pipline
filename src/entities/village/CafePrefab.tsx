import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { MultiInstances, StaticGroup, instanceTransform, type PrefabPart } from '../../shared/fiber/index.ts';
import { cafeBeam, cafeCanopy, cafeCanopyPoint, cafeJoin, cafeScallopedValance } from './cafeGeometry.ts';

function chairParts(): PrefabPart[] {
  const wood = new THREE.MeshStandardNodeMaterial({ color: '#805333', roughness: .79 });
  const seat = new THREE.MeshStandardNodeMaterial({ color: '#b29561', roughness: .94 });
  const legs = [-1, 1].flatMap(x => [-1, 1].map(z => cafeBeam([x * .205, .018, z * .21], [x * .17, .46, z * .17], .035)));
  const rails = [-1, 1].flatMap(side => [
    cafeBeam([side * .178, .19, -.18], [side * .178, .19, .18], .023),
    cafeBeam([-.178, .21, side * .18], [.178, .21, side * .18], .023),
    cafeBeam([side * .17, .44, -.17], [side * .19, .91, -.235], .033),
    cafeBeam([-.19, side === 1 ? .88 : .73, side === 1 ? -.231 : -.21], [.19, side === 1 ? .88 : .73, side === 1 ? -.231 : -.21], .066, .032),
  ]);
  const seatSlats = Array.from({ length: 7 }, (_, i) => new THREE.BoxGeometry(.366, .025, .045).translate(0, .4475, -.153 + i * .051));
  return [
    { id: 'timber-legs-rails-backrest', geometry: cafeJoin([...legs, ...rails]), material: wood },
    { id: 'slatted-seat', geometry: cafeJoin(seatSlats), material: seat },
  ];
}

function tableParts(): PrefabPart[] {
  const wood = new THREE.MeshStandardNodeMaterial({ color: '#93613b', roughness: .77 });
  const metal = new THREE.MeshStandardNodeMaterial({ color: '#40443c', roughness: .58, metalness: .55 });
  const top = cafeJoin(Array.from({ length: 9 }, (_, i) => {
    const z = (i - 4) * .068;
    const length = 2 * Math.sqrt(.325 ** 2 - z ** 2);
    return new THREE.BoxGeometry(length, .038, .061).translate(0, .721, z);
  }));
  const supports: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(.027, .038, .65, 12).translate(0, .374, 0), new THREE.CylinderGeometry(.2, .2, .025, 20).translate(0, .69, 0)];
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2;
    supports.push(cafeBeam([0, .13, 0], [Math.cos(angle) * .24, .018, Math.sin(angle) * .24], .033));
  }
  return [{ id: 'timber-round-slatted-top', geometry: top, material: wood }, { id: 'cast-pedestal-four-feet', geometry: cafeJoin(supports), material: metal }];
}

function PatioUmbrella() {
  const geometry = useMemo(cafeCanopy, []);
  const ribs = useMemo(() => cafeJoin(Array.from({ length: 8 }, (_, i) => {
    const angle = i / 8 * Math.PI * 2;
    const points = Array.from({ length: 8 }, (_, ring) => cafeCanopyPoint(angle, ring / 7 * 1.16).add(new THREE.Vector3(0, -.011, 0)));
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 12, .009, 5, false);
  })), []);
  const edging = useMemo(() => {
    const points = Array.from({ length: 65 }, (_, i) => cafeCanopyPoint(i / 64 * Math.PI * 2, 1.16));
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 96, .013, 5, false);
  }, []);
  return <group name="cafe-canvas-umbrella" position={[6.65, 1.5, -.1]}>
    <mesh name="umbrella-stone-foot" position={[0, .035, 0]}><cylinderGeometry args={[.2, .23, .07, 12]} /><meshStandardMaterial color="#b5ad96" roughness={.9} /></mesh>
    <mesh name="umbrella-slender-pole" position={[0, 1.17, 0]}><cylinderGeometry args={[.02, .025, 2.3, 10]} /><meshStandardMaterial color="#916d45" roughness={.75} /></mesh>
    <mesh name="umbrella-tensioned-eight-panel-canvas" geometry={geometry}><meshStandardMaterial color="#f3e6c5" roughness={.96} side={THREE.DoubleSide} /></mesh>
    <mesh name="umbrella-radial-ribs" geometry={ribs}><meshStandardMaterial color="#aa8a60" roughness={.82} /></mesh>
    <mesh name="umbrella-sewn-edge" geometry={edging}><meshStandardMaterial color="#d8c7a1" roughness={.95} /></mesh>
    <mesh name="umbrella-finial" position={[0, 2.31, 0]}><sphereGeometry args={[.042, 10, 8]} /><meshStandardMaterial color="#916d45" roughness={.75} /></mesh>
  </group>;
}

function CafeAwning() {
  const valance = useMemo(() => cafeScallopedValance(1.48), []);
  const braces = useMemo(() => cafeJoin([-1.52, 0, 1.52].flatMap(x => [
    cafeBeam([x, 2.31, 0], [x, 2.09, .67], .022),
    cafeBeam([x, 1.82, 0], [x, 2.09, .67], .022),
  ])), []);
  return <group name="cafe-two-panel-awning" position={[7.45, 1.5, -1.36]}>
    <mesh name="awning-folding-brackets" geometry={braces}><meshStandardMaterial color="#4b574a" roughness={.7} metalness={.35} /></mesh>
    {[-.76, .76].map((x, i) => <group key={i} name={`canvas-panel-${i}`}>
      <mesh position={[x, 2.206, .32]} rotation={[.32, 0, 0]}><boxGeometry args={[1.48, .016, .72]} /><meshStandardMaterial color={i ? '#ece0bc' : '#f0e5c7'} roughness={.96} /></mesh>
      <mesh name="scalloped-canvas-front" position={[x, 2.093, .663]} geometry={valance}><meshStandardMaterial color="#eee2bf" roughness={.96} /></mesh>
    </group>)}
    <mesh position={[0, 2.09, .66]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[.018, .018, 3.08, 10]} /><meshStandardMaterial color="#a89b7e" roughness={.78} /></mesh>
  </group>;
}

function CafeFrontage() {
  return <group name="cafe-shadowed-frontage" position={[7.45, 1.5, -1.405]}>
    <mesh name="deep-shadow-frontage" position={[0, 1.02, -.008]}><boxGeometry args={[2.96, 2.04, .025]} /><meshStandardMaterial color="#24382f" roughness={.97} /></mesh>
    {[-1.49, -.24, 1.49].map(x => <mesh key={x} position={[x, 1.04, .02]}><boxGeometry args={[.09, 2.08, .12]} /><meshStandardMaterial color="#3c6b67" roughness={.85} /></mesh>)}
    <mesh position={[0, 2.075, .02]}><boxGeometry args={[3.12, .11, .14]} /><meshStandardMaterial color="#3c6b67" roughness={.85} /></mesh>
    <mesh name="serving-window-counter" position={[-.86, .86, .14]}><boxGeometry args={[1.16, .065, .34]} /><meshStandardMaterial color="#8e6842" roughness={.8} /></mesh>
    <mesh name="counter-panel" position={[-.86, .42, .025]}><boxGeometry args={[1.12, .8, .075]} /><meshStandardMaterial color="#49746a" roughness={.84} /></mesh>
    {[0, 1].map(i => <group key={i} position={[i ? 1.35 : -.11, 1.01, .2]} rotation={[0, i ? -.62 : .62, 0]}>
      <mesh><boxGeometry args={[.19, 1.94, .045]} /><meshStandardMaterial color="#5c8374" roughness={.82} /></mesh>
    </group>)}
  </group>;
}

function Chalkboard() {
  const frame = useMemo(() => cafeJoin([-1, 1].flatMap(side => [
    cafeBeam([-.26, .02, side * .24], [-.26, .97, 0], .037),
    cafeBeam([.26, .02, side * .24], [.26, .97, 0], .037),
    cafeBeam([-.26, .24, side * .185], [.26, .24, side * .185], .04),
    cafeBeam([-.26, .91, side * .015], [.26, .91, side * .015], .04),
  ])), []);
  return <group name="cafe-freestanding-chalkboard" position={[8.83, 1.5, -.22]} rotation={[0, -.22, 0]}>
    <mesh geometry={frame}><meshStandardMaterial color="#a17643" roughness={.81} /></mesh>
    {[-1, 1].map(side => <mesh key={side} position={[0, .57, side * .098]} rotation={[side * -.245, 0, 0]}><boxGeometry args={[.46, .63, .019]} /><meshStandardMaterial color="#283c35" roughness={.99} /></mesh>)}
    <mesh position={[0, .95, 0]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[.021, .021, .57, 8]} /><meshStandardMaterial color="#544c39" roughness={.58} metalness={.4} /></mesh>
  </group>;
}

export function CafePrefab() {
  const chairs = useMemo(chairParts, []);
  const tables = useMemo(tableParts, []);
  const chairInstances = useMemo(() => [
    [6.2, .23, Math.PI], [6.18, -1.02, 0],
    [7.32, .14, Math.PI + .35], [8.16, -.38, Math.PI / 2], [7.65, -1.03, -.1],
  ].map(([x, z, yaw], i) => ({ id: `cafe-chair-${i}`, matrix: instanceTransform([x, 1.5, z], [1, 1, 1], [0, yaw, 0]) })), []);
  const tableInstances = useMemo(() => [[6.2, -.39], [7.58, -.4]].map(([x, z], i) => ({ id: `cafe-table-${i}`, matrix: instanceTransform([x, 1.5, z]) })), []);
  return <StaticGroup name="quayside-cafe-prefab" lightmap={false}>
    <CafeFrontage />
    <CafeAwning />
    <MultiInstances name="cafe-wooden-chairs" parts={chairs} instances={chairInstances} />
    <MultiInstances name="cafe-bistro-tables" parts={tables} instances={tableInstances} />
    <PatioUmbrella />
    <Chalkboard />
  </StaticGroup>;
}
