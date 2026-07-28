import * as THREE from 'three';
import type { WorldContext } from './context';

/**
 * UE-style ExponentialHeightFog with directional inscattering.
 *
 * Unreal's model: fog density decays exponentially with world height,
 * the amount along a view ray has a closed-form integral, and the fog
 * color leans toward the sun when you look at it (inscattering).
 * Three's built-in fog is bypassed entirely (materials keep fog:false);
 * we splice our own chunk into every material via patch().
 */

export interface HeightFogParams {
  /** Fog density at fog height (UE: FogDensity). */
  density: number;
  /** World height where density is `density` (UE: actor Z). */
  height: number;
  /** How fast density decays with height (UE: FogHeightFalloff). */
  falloff: number;
  /** Distance where fog starts (UE: StartDistance). */
  startDistance: number;
  /** Clamp so distant objects stay slightly visible (UE: FogMaxOpacity). */
  maxOpacity: number;
  /** Directional inscattering exponent (UE: DirectionalInscatteringExponent). */
  sunExponent: number;
}

const FOG_PARS = /* glsl */ `
  uniform vec3  uFogColor;
  uniform vec3  uFogSunColor;
  uniform vec3  uFogSunDir;
  uniform float uFogDensity;
  uniform float uFogHeight;
  uniform float uFogFalloff;
  uniform float uFogStart;
  uniform float uFogMaxOpacity;
  uniform float uFogSunExp;
  varying vec3  vHFWorldPos;

  vec3 applyHeightFog( vec3 color ) {
    vec3 ray = vHFWorldPos - cameraPosition;
    float dist = length( ray );
    vec3 rd = ray / max( dist, 1e-4 );

    // closed-form integral of exp(-falloff*(y - fogHeight)) along the ray
    float baseDensity = uFogDensity * exp( -uFogFalloff * ( cameraPosition.y - uFogHeight ) );
    float t = uFogFalloff * rd.y * dist;
    float lineIntegral = ( abs( t ) > 1e-4 ) ? ( 1.0 - exp( -t ) ) / t : 1.0 - 0.5 * t;
    float d = max( dist - uFogStart, 0.0 );
    float fogAmount = 1.0 - exp( -baseDensity * d * lineIntegral );
    fogAmount = min( fogAmount, uFogMaxOpacity );

    // directional inscattering — fog glows toward the sun
    float sunAmount = pow( clamp( dot( rd, uFogSunDir ), 0.0, 1.0 ), uFogSunExp );
    vec3 fogColor = mix( uFogColor, uFogSunColor, sunAmount );

    return mix( color, fogColor, fogAmount );
  }
`;

const FOG_VERT_PARS = /* glsl */ `
  varying vec3 vHFWorldPos;
`;

// runs right after <project_vertex>: `transformed` holds the displaced local position
const FOG_VERT = /* glsl */ `
  {
    vec4 hfWorld = vec4( transformed, 1.0 );
    #ifdef USE_INSTANCING
      hfWorld = instanceMatrix * hfWorld;
    #endif
    hfWorld = modelMatrix * hfWorld;
    vHFWorldPos = hfWorld.xyz;
  }
`;

export class HeightFog {
  params: HeightFogParams = {
    density: 0.006,
    height: 0,
    falloff: 0.02,
    startDistance: 40,
    maxOpacity: 0.96,
    sunExponent: 8,
  };

  readonly uniforms = {
    uFogColor: { value: new THREE.Color(0.65, 0.72, 0.8) },
    uFogSunColor: { value: new THREE.Color(1.0, 0.9, 0.75) },
    uFogSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uFogDensity: { value: 0.006 },
    uFogHeight: { value: 0 },
    uFogFalloff: { value: 0.02 },
    uFogStart: { value: 40 },
    uFogMaxOpacity: { value: 0.96 },
    uFogSunExp: { value: 8 },
  };

  /** Splice height fog into a built-in three.js material. */
  patch(material: THREE.Material): void {
    if ('fog' in material) (material as THREE.MeshStandardMaterial).fog = false;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      prev?.call(material, shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + FOG_VERT_PARS)
        .replace('#include <project_vertex>', '#include <project_vertex>\n' + FOG_VERT);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + FOG_PARS)
        .replace(
          '#include <dithering_fragment>',
          'gl_FragColor.rgb = applyHeightFog( gl_FragColor.rgb );\n#include <dithering_fragment>',
        );
    };
    material.customProgramCacheKey = () => 'heightfog';
  }

  /** GLSL to embed in hand-written ShaderMaterials. Call applyHeightFog() yourself. */
  static readonly parsFragment = FOG_PARS;
  static readonly parsVertex = FOG_VERT_PARS;
  static readonly vertexBody = FOG_VERT;

  /** Merge fog uniforms into a ShaderMaterial's uniform dictionary. */
  attach(uniforms: Record<string, THREE.IUniform>): void {
    Object.assign(uniforms, this.uniforms);
  }

  update(ctx: WorldContext): void {
    const u = this.uniforms;
    const p = this.params;
    u.uFogDensity.value = p.density;
    u.uFogHeight.value = p.height;
    u.uFogFalloff.value = p.falloff;
    u.uFogStart.value = p.startDistance;
    u.uFogMaxOpacity.value = p.maxOpacity;
    u.uFogSunExp.value = p.sunExponent;
    u.uFogSunDir.value.copy(ctx.sunDir);
    // aerial-perspective tint: horizon pulled toward zenith blue, never grey/cream
    u.uFogColor.value.copy(ctx.horizonColor).lerp(ctx.zenithColor, 0.7).multiplyScalar(0.75);
    u.uFogSunColor.value.copy(ctx.sunColor).multiplyScalar(0.25).add(
      new THREE.Color().copy(ctx.horizonColor).multiplyScalar(0.75),
    );
  }
}
