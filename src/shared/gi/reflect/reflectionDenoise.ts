import * as THREE from 'three/webgpu';
import { storage, texture, uniform, wgslFn } from 'three/tsl';
import type { ReflectionReader } from './reflectionPass.ts';

const MIRROR_ROUGHNESS = 0.08;

export interface ReflectionDenoiseInputs {
  traced: [THREE.StorageBufferAttribute, THREE.StorageBufferAttribute];
  depth: [THREE.StorageBufferAttribute, THREE.StorageBufferAttribute];
  normal: THREE.Texture;
  spec: THREE.Texture;
  width: number;
  height: number;
}

type LoadExpr = (index: string) => string;

const STAGE = (load: LoadExpr, dst: string, depthA: string, depthB: string) => `
  fn reflectDenoise( normalTex: texture_2d<f32>, specTex: texture_2d<f32>, size: vec2f, step: f32, parity: f32 ) -> void {
    let i = instanceIndex;
    let width = i32( size.x );
    let height = i32( size.y );
    if ( i32( i ) >= width * height ) { return; }
    let px = vec2i( i32( i ) % width, i32( i ) / width );
    let gsize = vec2f( textureDimensions( normalTex ) );
    let toG = gsize / size;
    let gpx = vec2i( ( vec2f( px ) + 0.5 ) * toG );
    let n0 = normalize( textureLoad( normalTex, gpx, 0 ).xyz );
    let r0 = clamp( textureLoad( specTex, gpx, 0 ).a, 0.02, 1.0 );
    let c0 = ${load('i')};
    if ( c0.a <= 0.0 || r0 < ${MIRROR_ROUGHNESS} ) { ${dst}.value[ i ] = c0; return; }
    let z0 = select( ${depthA}.value[ i ], ${depthB}.value[ i ], parity > 0.5 );
    let stepPx = i32( max( 1.0, round( step * ( 1.0 + min( 0.5, r0 ) ) ) ) );
    let l0 = dot( c0.rgb, vec3f( 0.2126, 0.7152, 0.0722 ) );
    let kernel = array<f32, 5>( 0.0625, 0.25, 0.375, 0.25, 0.0625 );
    var sum = vec3f( 0.0 );
    var wsum = 0.0;
    for ( var dy = -2; dy <= 2; dy++ ) {
      for ( var dx = -2; dx <= 2; dx++ ) {
        let q = clamp( px + vec2i( dx, dy ) * stepPx, vec2i( 0 ), vec2i( width - 1, height - 1 ) );
        let qi = u32( q.y * width + q.x );
        let cq = ${load('qi')};
        if ( cq.a <= 0.0 ) { continue; }
        let gq = vec2i( ( vec2f( q ) + 0.5 ) * toG );
        let nq = normalize( textureLoad( normalTex, gq, 0 ).xyz );
        let rq = clamp( textureLoad( specTex, gq, 0 ).a, 0.02, 1.0 );
        let zq = select( ${depthA}.value[ qi ], ${depthB}.value[ qi ], parity > 0.5 );
        let lq = dot( cq.rgb, vec3f( 0.2126, 0.7152, 0.0722 ) );
        let w = kernel[ dx + 2 ] * kernel[ dy + 2 ]
          * exp( -abs( lq - l0 ) / ( 0.35 * l0 + 0.02 ) )
          * exp( -abs( zq - z0 ) / ( 0.05 * z0 + 0.01 ) )
          * pow( max( dot( n0, nq ), 0.0 ), 32.0 )
          * exp( -abs( rq - r0 ) * 10.0 );
        sum += cq.rgb * w;
        wsum += w;
      }
    }
    ${dst}.value[ i ] = vec4f( select( c0.rgb, sum / wsum, wsum > 1e-4 ), c0.a );
  }
`;

export class ReflectionDenoiser {
  private static allocations = 0;
  passes = 2;
  private readonly stages: THREE.ComputeNode[];
  private readonly uStep = [uniform(1), uniform(2), uniform(4)];
  private readonly uParity = uniform(0);
  private readonly readerParity = uniform(0);
  private readonly readerObject: ReflectionReader;
  readonly width: number;
  readonly height: number;

  constructor(private readonly renderer: THREE.WebGPURenderer, inputs: ReflectionDenoiseInputs) {
    this.width = inputs.width;
    this.height = inputs.height;
    const count = inputs.width * inputs.height;
    const id = ReflectionDenoiser.allocations++;
    const buffer = () => new THREE.StorageBufferAttribute(new Float32Array(count * 4), 4);
    const outputs = [buffer(), buffer()];
    const names = { srcA: `dnTraced${id}A`, srcB: `dnTraced${id}B`, depthA: `dnDepth${id}A`, depthB: `dnDepth${id}B`, outA: `dnOut${id}A`, outB: `dnOut${id}B` };
    const read = (attr: THREE.StorageBufferAttribute, type: string, name: string) => storage(attr, type, count).toReadOnly().setName(name);
    const write = (attr: THREE.StorageBufferAttribute, name: string) => storage(attr, 'vec4', count).setName(name);
    const depth = [read(inputs.depth[0], 'float', names.depthA), read(inputs.depth[1], 'float', names.depthB)];
    const outA = write(outputs[0], names.outA);
    const outB = write(outputs[1], names.outB);
    const uSize = uniform(new THREE.Vector2(inputs.width, inputs.height));
    const stage = (load: LoadExpr, includes: THREE.Node[], dst: string, step: THREE.UniformNode<number>) =>
      (wgslFn(STAGE(load, dst, names.depthA, names.depthB), [...depth, ...includes]) as any)({
        normalTex: texture(inputs.normal), specTex: texture(inputs.spec), size: uSize, step, parity: this.uParity,
      }).compute(count).setName('Reflections denoise') as THREE.ComputeNode;
    const fromTraced: LoadExpr = (index) => `select( ${names.srcA}.value[ ${index} ], ${names.srcB}.value[ ${index} ], parity > 0.5 )`;
    this.stages = [
      stage(fromTraced, [read(inputs.traced[0], 'vec4', names.srcA), read(inputs.traced[1], 'vec4', names.srcB), outA], names.outA, this.uStep[0]),
      stage((index) => `${names.outA}r.value[ ${index} ]`, [read(outputs[0], 'vec4', `${names.outA}r`), outB], names.outB, this.uStep[1]),
      stage((index) => `${names.outB}r.value[ ${index} ]`, [read(outputs[1], 'vec4', `${names.outB}r`), outA], names.outA, this.uStep[2]),
    ];
    this.readerObject = {
      current: read(outputs[0], 'vec4', `dnRead${id}A`),
      previous: read(outputs[1], 'vec4', `dnRead${id}B`),
      parity: this.readerParity,
      width: inputs.width,
      height: inputs.height,
    };
  }

  get reader(): ReflectionReader {
    return this.readerObject;
  }

  run(parity: number): void {
    const passes = Math.max(1, Math.min(3, Math.round(this.passes)));
    this.uParity.value = parity;
    for (let s = 0; s < passes; s++) this.renderer.compute(this.stages[s]);
    this.readerParity.value = (passes - 1) % 2;
  }
}
