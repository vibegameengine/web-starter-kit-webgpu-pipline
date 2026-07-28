import * as THREE from 'three';
import type { WorldContext } from '../../shared/engine/context';

/**
 * Cloud layer in the spirit of UE volumetric clouds, on a budget:
 * a sky-wide dome slice with 5-octave FBM density, pseudo-volumetric
 * sun shading (density gradient toward the sun = silver lining),
 * horizon fade into the atmosphere.
 */

const VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4( position, 1.0 );
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vWorld;
  uniform float uTime;
  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform vec3  uSkyColor;
  uniform vec3  uHorizonColor;
  uniform vec2  uWind;
  uniform float uCoverage;

  float hash( vec2 p ) {
    return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
  }
  float noise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix(
      mix( hash( i ), hash( i + vec2( 1.0, 0.0 ) ), f.x ),
      mix( hash( i + vec2( 0.0, 1.0 ) ), hash( i + vec2( 1.0, 1.0 ) ), f.x ),
      f.y );
  }
  float fbm( vec2 p ) {
    float a = 0.5;
    float s = 0.0;
    mat2 r = mat2( 0.8, 0.6, -0.6, 0.8 );
    for ( int i = 0; i < 5; i++ ) {
      s += a * noise( p );
      p = r * p * 2.03;
      a *= 0.5;
    }
    return s;
  }

  float density( vec2 uv ) {
    float base = fbm( uv );
    float detail = fbm( uv * 3.7 + 11.3 );
    float d = base * 0.72 + detail * 0.28;
    // fbm clusters around 0.5 — window the threshold band inside that range
    float lo = 0.92 - uCoverage * 0.85;
    return smoothstep( lo, lo + 0.14, d );
  }

  void main() {
    vec2 drift = uWind * uTime * 3.0;
    vec2 uv = vWorld.xz * 0.00045 + drift * 0.0004;

    float d = density( uv );
    if ( d < 0.004 ) discard;

    // pseudo-volumetric shading: march density toward the sun in the sheet plane
    vec2 sunStep = normalize( uSunDir.xz + vec2( 1e-4 ) ) * 0.012;
    float dSun = density( uv + sunStep ) ;
    float dSun2 = density( uv + sunStep * 2.5 );
    float shade = clamp( ( d - dSun ) * 2.2 + ( d - dSun2 ) * 1.2, -1.0, 1.0 );

    float sunH = clamp( uSunDir.y, 0.0, 1.0 );
    vec3 lit = uSunColor * ( 0.85 + 0.5 * shade ) * ( 0.35 + 0.65 * sunH );
    vec3 dark = uSkyColor * 0.55;
    vec3 col = mix( dark, lit, clamp( 0.55 + shade * 0.6, 0.0, 1.0 ) );

    // silver lining where thin and facing the sun
    float rim = ( 1.0 - d ) * max( shade, 0.0 );
    col += uSunColor * rim * 0.7;

    // aerial perspective: fade to horizon color with distance
    float dist = length( vWorld.xz - cameraPosition.xz );
    float haze = 1.0 - exp( -dist * 0.00012 );
    col = mix( col, uHorizonColor, haze );

    float alpha = d * 0.92 * ( 1.0 - haze * 0.5 );
    gl_FragColor = vec4( col, alpha );
  }
`;

export function createClouds(coverage = 0.5) {
  const uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uSkyColor: { value: new THREE.Color(0.5, 0.65, 0.85) },
    uHorizonColor: { value: new THREE.Color(0.75, 0.82, 0.9) },
    uWind: { value: new THREE.Vector2(1, 0) },
    uCoverage: { value: coverage },
  };

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  // gently domed sheet so the layer bows down toward the horizon
  const geo = new THREE.SphereGeometry(8000, 48, 12, 0, Math.PI * 2, 0, Math.PI * 0.26);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -7300; // sphere top ends up ~700m above ground
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;

  function update(ctx: WorldContext): void {
    uniforms.uTime.value = ctx.time;
    uniforms.uSunDir.value.copy(ctx.sunDir);
    uniforms.uSunColor.value.copy(ctx.sunColor);
    uniforms.uSkyColor.value.copy(ctx.skyColor);
    uniforms.uHorizonColor.value.copy(ctx.horizonColor);
    uniforms.uWind.value.copy(ctx.windDir);
  }

  return { mesh, update };
}
