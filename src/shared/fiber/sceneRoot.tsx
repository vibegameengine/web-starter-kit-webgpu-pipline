import { Component, useLayoutEffect, type ReactNode } from 'react';
import { advance, createRoot, events, extend, useFrame, type RootStore } from '@vibegameengine/react-three-fiber';
import * as THREE from 'three/webgpu';

extend({ Group: THREE.Group, Mesh: THREE.Mesh, InstancedMesh: THREE.InstancedMesh, BoxGeometry: THREE.BoxGeometry, SphereGeometry: THREE.SphereGeometry, CylinderGeometry: THREE.CylinderGeometry, ConeGeometry: THREE.ConeGeometry, TorusGeometry: THREE.TorusGeometry, MeshStandardMaterial: THREE.MeshStandardNodeMaterial });

class SceneBoundary extends Component<{ children: ReactNode; onError(error: Error): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.onError(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

function PipelineFrameOwner({ children, onCommit }: { children: ReactNode; onCommit(): void }) {
  useFrame(() => undefined, 1);
  useLayoutEffect(() => { queueMicrotask(onCommit); }, [onCommit]);
  return children;
}

export async function createFiberSceneRoot(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
  const root = createRoot(renderer.domElement);
  const toneMapping = renderer.toneMapping;
  const outputColorSpace = renderer.outputColorSpace;
  await root.configure({
    gl: renderer, scene, camera, frameloop: 'never', events,
    dpr: renderer.getPixelRatio(), shadows: { enabled: true, type: renderer.shadowMap.type ?? THREE.PCFSoftShadowMap },
    size: { width: renderer.domElement.clientWidth, height: renderer.domElement.clientHeight, top: 0, left: 0 },
  });
  renderer.toneMapping = toneMapping;
  renderer.outputColorSpace = outputColorSpace;
  let store: RootStore;
  return {
    async render(children: ReactNode) {
      await new Promise<void>((resolve, reject) => {
        const onCommit = () => { scene.updateMatrixWorld(true); resolve(); };
        store = root.render(<SceneBoundary onError={reject}><PipelineFrameOwner onCommit={onCommit}>{children}</PipelineFrameOwner></SceneBoundary>);
      });
    },
    advance(timeSeconds: number) { advance(timeSeconds, false, store.getState()); },
    resize(width: number, height: number) { store.getState().setSize(width, height); },
  };
}
