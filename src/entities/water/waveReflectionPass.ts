import * as THREE from 'three/webgpu';
import { Fn, If, instanceIndex, mrt, normalize, positionWorld, reflect, sampler, texture, textureLoad, textureStore, uniform, uvec2, vec3, vec4 } from 'three/tsl';
import { waveReflection, type WaveReflectionOptions } from './waveReflection.ts';
import { sampleWaterPmrem } from './pmremSample.ts';
import { waterSolarScatter, type VolumeLightOptions } from './volumeLight.ts';

type PassOptions = Omit<WaveReflectionOptions, 'sampleEnvironment'> & VolumeLightOptions & { environment: THREE.Texture };

export class WaveReflectionPass {
  readonly target = { texture: new THREE.StorageTexture(1, 1) };
  readonly volume = { texture: new THREE.StorageTexture(1, 1) };
  private readonly field = new THREE.RenderTarget(1, 1, { type: THREE.FloatType, count: 2 });
  private readonly scene = new THREE.Scene();
  private readonly mesh: THREE.Mesh;
  private readonly compute: THREE.ComputeNode;
  private readonly volumeCompute: THREE.ComputeNode;
  private readonly width = uniform(1, 'uint');
  private readonly count = uniform(1, 'uint');
  private readonly volumeWidth = uniform(1, 'uint');
  private readonly volumeCount = uniform(1, 'uint');
  private readonly fieldMrt;
  private readonly size = new THREE.Vector2();
  private readonly environment: THREE.RenderTarget;

  constructor(renderer: THREE.WebGPURenderer, geometry: THREE.BufferGeometry, position: THREE.Node, normal: THREE.Node, roughness: THREE.Node, options: PassOptions) {
    const generator = new THREE.PMREMGenerator(renderer);
    this.environment = generator.fromEquirectangular(options.environment);
    generator.dispose();
    const environment = texture(this.environment.texture);
    const transport: WaveReflectionOptions = { ...options, sampleEnvironment: (ray, roughness) => {
      const direction = vec3(ray);
      return sampleWaterPmrem({ atlas: environment, atlasSampler: sampler(this.environment.texture),
        direction: vec3(direction.x, direction.y.negate(), direction.z), roughness });
    } };
    this.field.textures[0].name = 'output';
    this.field.textures[1].name = 'surfaceNormal';
    this.fieldMrt = mrt({ output: vec4(positionWorld, 1), surfaceNormal: vec4(normal, roughness) });
    const material = new THREE.MeshBasicNodeMaterial({ toneMapped: false });
    material.positionNode = position;
    material.fragmentNode = this.fieldMrt;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.target.texture.type = THREE.HalfFloatType;
    this.volume.texture.type = THREE.HalfFloatType;
    const camera = new THREE.Vector3();
    const cameraNode = uniform(camera);
    this.cameraPosition = camera;
    this.compute = Fn(() => {
      If(instanceIndex.lessThan(this.count), () => {
        const pixel = uvec2(instanceIndex.mod(this.width), instanceIndex.div(this.width));
        const point = textureLoad(this.field.textures[0], pixel).toVar();
        const radiance = vec4(0).toVar();
        If(point.a.greaterThan(0.5), () => {
          const surface = textureLoad(this.field.textures[1], pixel).toVar();
          const normal = normalize(surface.xyz);
          const direction = reflect(normalize(point.xyz.sub(cameraNode)), normal);
          radiance.assign(vec4(waveReflection(transport, point.xyz, direction, normal, surface.w), 1));
        });
        textureStore(this.target.texture, pixel, radiance);
      });
    })().compute(1);
    this.volumeCompute = Fn(() => {
      If(instanceIndex.lessThan(this.volumeCount), () => {
        const pixel = uvec2(instanceIndex.mod(this.volumeWidth), instanceIndex.div(this.volumeWidth));
        const samplePixel = pixel.mul(8).min(uvec2(this.width.sub(1), this.count.div(this.width).sub(1)));
        const point = textureLoad(this.field.textures[0], samplePixel).toVar();
        const scatter = vec4(0).toVar();
        If(point.a.greaterThan(0.5), () => {
          const normal = normalize(textureLoad(this.field.textures[1], samplePixel).xyz);
          scatter.assign(vec4(waterSolarScatter(options, point.xyz, point.xyz.sub(cameraNode), normal), 1));
        });
        textureStore(this.volume.texture, pixel, scatter);
      });
    })().compute(1);
  }

  private readonly cameraPosition: THREE.Vector3;

  update(renderer: THREE.WebGPURenderer, camera: THREE.Camera, source: THREE.Object3D): void {
    renderer.getDrawingBufferSize(this.size);
    this.size.set(Math.ceil(this.size.x / 2), Math.ceil(this.size.y / 2));
    if (this.field.width !== this.size.x || this.field.height !== this.size.y) {
      this.field.setSize(this.size.x, this.size.y);
      this.target.texture.setSize(this.size.x, this.size.y, 1);
      const volumeWidth = Math.ceil(this.size.x / 8), volumeHeight = Math.ceil(this.size.y / 8);
      this.volume.texture.setSize(volumeWidth, volumeHeight, 1);
      this.volumeWidth.value = volumeWidth;
      this.volumeCount.value = volumeWidth * volumeHeight;
      this.volumeCompute.setCount(volumeWidth * volumeHeight);
      this.width.value = this.size.x;
      this.count.value = this.size.x * this.size.y;
      this.compute.setCount(this.size.x * this.size.y);
    }
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrix.copy(source.matrixWorld);
    const previousTarget = renderer.getRenderTarget(), previousMrt = renderer.getMRT();
    const color = renderer.getClearColor(new THREE.Color() as Parameters<THREE.WebGPURenderer['getClearColor']>[0]), alpha = renderer.getClearAlpha();
    const mask = camera.layers.mask;
    camera.layers.set(0);
    renderer.setClearColor(0, 0);
    renderer.setRenderTarget(this.field);
    renderer.setMRT(this.fieldMrt);
    renderer.render(this.scene, camera);
    renderer.setMRT(null);
    renderer.compute(this.compute);
    renderer.compute(this.volumeCompute);
    renderer.setRenderTarget(previousTarget);
    renderer.setMRT(previousMrt);
    renderer.setClearColor(color, alpha);
    camera.layers.mask = mask;
  }

  dispose(): void {
    this.field.dispose();
    this.target.texture.dispose();
    this.volume.texture.dispose();
    this.environment.dispose();
    this.compute.dispose();
    this.volumeCompute.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
