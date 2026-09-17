import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { color as tslColor } from 'three/tsl';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createScene } from '../../shared/gi/surfel/scene.ts';
import { Layer } from '../../shared/world/index.ts';
import { createFiberSceneRoot, StaticGroup } from '../../shared/fiber/index.ts';
import { bootStage } from '../../shared/ui/bootProgress.ts';

export interface LodScaleScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sun: THREE.DirectionalLight;
  update: (elapsedSeconds: number) => void;
}

const DEFAULT_GROUND_METRES = 24;
const PERGOLA_SPAN = 8;
const PERGOLA_HEIGHT = 2.6;
const SLAT_PITCH = 0.5;
const SLAT_WIDTH = 0.12;
const CABINS: { scale: number; at: [number, number] }[] = [
  { scale: 0.5, at: [1, 1] },
  { scale: 1, at: [-1, 5] },
  { scale: 2, at: [-6, 5] },
  { scale: 4, at: [6, 4] },
];
const PERGOLA_CENTRE: [number, number, number] = [-6, 0, -5];
const LONG_WALL_METRES = 18;
const GLOW_BAR_WIDTH = 0.06;
const GLOW_COLOUR = '#ffb070';
const GLOW_INTENSITY = 10;

const CAMERA_PRESETS: Record<string, [number[], number[]]> = {
  overview: [[22, 18, 22], [0, 1, 0]],
  eye: [[-11, 1.7, 11], [6, 0.6, -6]],
  grazing: [[-11.5, 0.5, 2], [11, 0, 2]],
  pergola: [[-3, 1.4, 1], [-6, 0, -5]],
  ladder: [[0, 3, 15], [0, 1.5, 4]],
  wall: [[4, 2, -6], [-2, 1.5, -11]],
  glow: [[6, 1.6, 2], [6, 0, -4]],
  far: [[60, 30, 60], [0, 0, 0]],
};

function Slats({ span, height, pitch, width, axis }: { span: number; height: number; pitch: number; width: number; axis: 'x' | 'z' }) {
  const count = Math.floor(span / pitch);
  return <>
    {Array.from({ length: count }, (_, index) => {
      const offset = -span / 2 + pitch * (index + 0.5);
      const position: [number, number, number] = axis === 'x' ? [offset, height, 0] : [0, height, offset];
      const size: [number, number, number] = axis === 'x' ? [width, width, span] : [span, width, width];
      return <mesh key={index} name={`slat-${axis}-${index}`} position={position}><boxGeometry args={size}/><meshStandardMaterial color="#6b5a48" roughness={0.9}/></mesh>;
    })}
  </>;
}

function Fence({ name, span, height, pitch, width }: { name: string; span: number; height: number; pitch: number; width: number }) {
  const count = Math.floor(span / pitch);
  return <StaticGroup name={name} lightmap={false}>
    {Array.from({ length: count }, (_, index) => (
      <mesh key={index} name={`${name}-${index}`} position={[-span / 2 + pitch * (index + 0.5), height / 2, 0]}>
        <boxGeometry args={[width, height, width]}/><meshStandardMaterial color="#6b5a48" roughness={0.9}/>
      </mesh>
    ))}
  </StaticGroup>;
}

function glowMaterial(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0x101010, roughness: 1, metalness: 0 });
  const colour = new THREE.Color(GLOW_COLOUR);
  material.emissive = colour;
  material.emissiveIntensity = GLOW_INTENSITY;
  material.emissiveNode = tslColor(colour).mul(GLOW_INTENSITY);
  material.name = 'lodScaleGlow';
  return material;
}

function GlowBars({ name, span, length, pitch, lift, upright }: { name: string; span: number; length: number; pitch: number; lift: number; upright: boolean }) {
  const count = Math.floor(span / pitch);
  const material = useMemo(glowMaterial, []);
  return <StaticGroup name={name} lightmap={false}>
    {Array.from({ length: count }, (_, index) => {
      const offset = -span / 2 + pitch * (index + 0.5);
      const position: [number, number, number] = upright ? [offset, lift + length / 2, 0] : [offset, lift, 0];
      const size: [number, number, number] = upright ? [GLOW_BAR_WIDTH, length, GLOW_BAR_WIDTH] : [GLOW_BAR_WIDTH, GLOW_BAR_WIDTH, length];
      return <mesh key={index} name={`${name}-${index}`} position={position} material={material}><boxGeometry args={size}/></mesh>;
    })}
  </StaticGroup>;
}

function Pergola() {
  const posts = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => [sx * PERGOLA_SPAN / 2, sz * PERGOLA_SPAN / 2] as const));
  return <StaticGroup name="pergola" position={PERGOLA_CENTRE} lightmap={false}>
    {posts.map(([x, z], index) => <mesh key={index} name={`pergola-post-${index}`} position={[x, PERGOLA_HEIGHT / 2, z]}><boxGeometry args={[0.2, PERGOLA_HEIGHT, 0.2]}/><meshStandardMaterial color="#6b5a48" roughness={0.9}/></mesh>)}
    <Slats span={PERGOLA_SPAN} height={PERGOLA_HEIGHT} pitch={SLAT_PITCH} width={SLAT_WIDTH} axis="x"/>
    <Slats span={PERGOLA_SPAN} height={PERGOLA_HEIGHT + SLAT_WIDTH} pitch={SLAT_PITCH * 2} width={SLAT_WIDTH} axis="z"/>
  </StaticGroup>;
}

function Cabin({ scale, at }: { scale: number; at: [number, number] }) {
  const size = 2 * scale;
  return <StaticGroup name={`cabin-x${scale}`} position={[at[0], 0, at[1]]}>
    <mesh name={`cabin-x${scale}-body`} position={[0, size / 2, 0]}><boxGeometry args={[size, size, size]}/><meshStandardMaterial color="#8f897d" roughness={0.95}/></mesh>
    <group position={[0, 0, size / 2 + 0.6 * scale]}>
      <Fence name={`cabin-x${scale}-fence`} span={size} height={size * 0.8} pitch={0.3 * scale} width={0.08 * scale}/>
    </group>
  </StaticGroup>;
}

function LongWall() {
  return <StaticGroup name="long-wall" position={[0, 0, -11]}>
    <mesh name="long-wall-body" position={[0, 1.5, 0]}><boxGeometry args={[LONG_WALL_METRES, 3, 0.3]}/><meshStandardMaterial color="#8c806f" roughness={0.95}/></mesh>
    <group position={[0, 0, 1.2]}>
      <Fence name="long-wall-fence" span={LONG_WALL_METRES} height={2.6} pitch={0.4} width={0.1}/>
    </group>
    <group position={[0, 0, 0.25]}>
      <GlowBars name="long-wall-glow" span={LONG_WALL_METRES} length={2.4} pitch={0.8} lift={0.3} upright/>
    </group>
  </StaticGroup>;
}

/**
 * @important A stand for the lightmap LOD, not a pretty scene. Every surface under test is
 * large and carries high-frequency baked light: the pergola, the fences and the long wall
 * throw slat shadows a few texels apart, so a coarser level, a tile seam or a jump between
 * levels shows as blur, a line or a step instead of disappearing into flat colour. The lightmap
 * holds indirect light only, so the sharp pattern it must carry comes from glowing bars a few
 * centimetres off the ground and the wall, not from the sun's slat shadows. The
 * cabins are one shape at four scales, so the same wall is a tail-only chart at x0.5 and
 * a tiled chart three levels deep at x4. The slats themselves take no chart
 * (`lightmap={false}`): they are occluders, and thousands of thin charts would only fill
 * the tail.
 */
export async function createLodScaleScene(renderer: THREE.WebGPURenderer): Promise<LodScaleScene> {
  const { scene, camera, controls, dirLight: sun } = createScene(renderer);
  scene.name = 'lod-scale';
  scene.background = null;
  camera.fov = 50;
  camera.near = 0.05;
  camera.far = 400;
  const params = new URLSearchParams(location.search);
  const groundMetres = Number(params.get('ground') ?? DEFAULT_GROUND_METRES);
  const [position, target] = CAMERA_PRESETS[params.get('cam') ?? ''] ?? CAMERA_PRESETS.overview;
  camera.position.fromArray(position);
  controls.target.fromArray(target);
  camera.updateProjectionMatrix();
  camera.layers.enable(Layer.Debug);
  controls.update();

  const elevation = THREE.MathUtils.degToRad(Number(params.get('sunElevation') ?? '38'));
  const azimuth = THREE.MathUtils.degToRad(Number(params.get('sunAzimuth') ?? '35'));
  sun.position.set(Math.cos(elevation) * Math.cos(azimuth) * 40, Math.sin(elevation) * 40, Math.cos(elevation) * Math.sin(azimuth) * 40);
  sun.target.position.set(0, 0, 0);
  scene.add(sun.target);

  const fiber = await createFiberSceneRoot(renderer, scene, camera);
  await bootStage('LOD scale stand: ground, pergola, cabins, wall', () => fiber.render(
    <group name="lod-scale">
      <StaticGroup name="ground">
        <mesh name="ground-slab" position={[0, -0.1, 0]}><boxGeometry args={[groundMetres, 0.2, groundMetres]}/><meshStandardMaterial color="#77736b" roughness={1}/></mesh>
      </StaticGroup>
      <Pergola/>
      <group position={[6, 0, -4]}>
        <GlowBars name="ground-glow" span={8} length={8} pitch={0.6} lift={0.08} upright={false}/>
      </group>
      {CABINS.map((cabin) => <Cabin key={cabin.scale} scale={cabin.scale} at={cabin.at}/>)}
      <LongWall/>
    </group>,
  ));
  window.addEventListener('resize', () => fiber.resize(renderer.domElement.clientWidth, renderer.domElement.clientHeight));

  return { scene, camera, controls, sun, update(t) { fiber.advance(t); } };
}
