import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, useFrame } from '@vibegameengine/react-three-fiber';
import type * as THREE from 'three';

function Spinner({ position, color }: { position: [number, number, number]; color: string }) {
  const mesh = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  useFrame((_state, delta) => {
    if (!mesh.current) return;
    mesh.current.rotation.x += delta * 0.6;
    mesh.current.rotation.y += delta * 0.9;
  });
  return (
    <mesh
      ref={mesh}
      position={position}
      scale={hovered ? 1.25 : 1}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={hovered ? '#f5d08a' : color} roughness={0.35} metalness={0.1} />
    </mesh>
  );
}

function Lab() {
  return (
    <Canvas camera={{ position: [0, 1.6, 5], fov: 45 }} data-testid="fiber-canvas">
      <color attach="background" args={['#0c1016']} />
      <ambientLight intensity={0.4} />
      <directionalLight position={[4, 6, 3]} intensity={2.4} />
      <Spinner position={[-1.6, 0, 0]} color="#4fb3c9" />
      <Spinner position={[1.6, 0, 0]} color="#c9744f" />
      <mesh position={[0, -1.4, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[16, 16]} />
        <meshStandardMaterial color="#1b222c" roughness={0.9} />
      </mesh>
    </Canvas>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Lab />
  </StrictMode>,
);
