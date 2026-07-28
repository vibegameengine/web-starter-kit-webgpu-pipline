// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type SceneBundle = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;

  controls: OrbitControls;
  dirLight: THREE.DirectionalLight;
  hemi?: THREE.HemisphereLight;
};

export function createScene(renderer: THREE.WebGPURenderer): SceneBundle {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x202025);

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    2000,
  );
  camera.position.set(2, 5, 5);

  const controls = new OrbitControls(camera, renderer.domElement);
  // controls.enableDamping = true;
  controls.target.set(0, 0, 0);

  // const hemi = new THREE.HemisphereLight(0xffffff, 0x444466, 0.15);
  // scene.add(hemi);

  const dirLight = new THREE.DirectionalLight(0xffffff, 4.0);
  dirLight.position.set(10, 30, 10);
  dirLight.castShadow = true;
  scene.add(dirLight);

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  return { scene, camera, controls, dirLight };
}
