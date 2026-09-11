import { wgsl, wgslFn } from 'three/tsl';

export const cubeConstants = wgsl(`
  const REFL_FLAG_HIT: u32 = 1u;
  const REFL_FLAG_SKY: u32 = 2u;
  const REFL_FLAG_UNKNOWN: u32 = 4u;
  const REFL_FLAG_CENTER_DEPTH: u32 = 8u;
  const REFL_SKY_DISTANCE: f32 = 1.0e5;
`);

export const faceDirection = wgslFn(`
  fn reflFaceDirection( face: u32, s: f32, t: f32 ) -> vec3f {
    switch ( face ) {
      case 0u: { return normalize( vec3f( 1.0, -t, -s ) ); }
      case 1u: { return normalize( vec3f( -1.0, -t, s ) ); }
      case 2u: { return normalize( vec3f( s, 1.0, t ) ); }
      case 3u: { return normalize( vec3f( s, -1.0, -t ) ); }
      case 4u: { return normalize( vec3f( s, -t, 1.0 ) ); }
      default: { return normalize( vec3f( -s, -t, -1.0 ) ); }
    }
  }
`);

export const directionToFace = wgslFn(`
  fn reflDirectionToFace( dir: vec3f ) -> vec3f {
    let a = abs( dir );
    if ( a.x >= a.y && a.x >= a.z ) {
      let ma = max( a.x, 1.0e-8 );
      if ( dir.x > 0.0 ) { return vec3f( 0.0, -dir.z / ma, -dir.y / ma ); }
      return vec3f( 1.0, dir.z / ma, -dir.y / ma );
    }
    if ( a.y >= a.z ) {
      let ma = max( a.y, 1.0e-8 );
      if ( dir.y > 0.0 ) { return vec3f( 2.0, dir.x / ma, dir.z / ma ); }
      return vec3f( 3.0, dir.x / ma, -dir.z / ma );
    }
    let ma = max( a.z, 1.0e-8 );
    if ( dir.z > 0.0 ) { return vec3f( 4.0, dir.x / ma, -dir.y / ma ); }
    return vec3f( 5.0, -dir.x / ma, -dir.y / ma );
  }
`);

export const jacobian = wgslFn(`
  fn reflJacobian( s: f32, t: f32 ) -> f32 {
    let d = 1.0 + s * s + t * t;
    return inverseSqrt( d * d * d );
  }
`);

export const hash21 = wgslFn(`
  fn reflHash( a: u32, b: u32 ) -> vec2f {
    var h = a * 747796405u + b * 2891336453u + 1u;
    h = ( ( h >> ( ( h >> 28u ) + 4u ) ) ^ h ) * 277803737u;
    h = ( h >> 22u ) ^ h;
    var g = b * 1664525u + a * 1013904223u + 2654435761u;
    g = ( ( g >> ( ( g >> 28u ) + 4u ) ) ^ g ) * 277803737u;
    g = ( g >> 22u ) ^ g;
    return vec2f( f32( h & 0xffffffu ) / 16777216.0, f32( g & 0xffffffu ) / 16777216.0 );
  }
`);

export const neighborTexel = wgslFn(
  `
  fn reflNeighborTexel( face: u32, ix: i32, iy: i32, side: i32 ) -> u32 {
    if ( ix >= 0 && iy >= 0 && ix < side && iy < side ) {
      return face * u32( side * side ) + u32( iy * side + ix );
    }
    let sideF = f32( side );
    let s = ( f32( ix ) + 0.5 ) / sideF * 2.0 - 1.0;
    let t = ( f32( iy ) + 0.5 ) / sideF * 2.0 - 1.0;
    let dir = reflFaceDirection( face, s, t );
    let ft = reflDirectionToFace( dir );
    let nf = u32( ft.x );
    let nx = clamp( i32( ( ft.y * 0.5 + 0.5 ) * sideF ), 0, side - 1 );
    let ny = clamp( i32( ( ft.z * 0.5 + 0.5 ) * sideF ), 0, side - 1 );
    return nf * u32( side * side ) + u32( ny * side + nx );
  }
`,
  [faceDirection, directionToFace] as never,
);

export const sampleScratch = wgslFn(
  `
  fn reflSampleScratch( dir: vec3f, side: i32 ) -> vec3f {
    let ft = reflDirectionToFace( dir );
    let face = u32( ft.x );
    let sideF = f32( side );
    let fx = ( ft.y * 0.5 + 0.5 ) * sideF - 0.5;
    let fy = ( ft.z * 0.5 + 0.5 ) * sideF - 0.5;
    let x0 = i32( floor( fx ) );
    let y0 = i32( floor( fy ) );
    let wx = fx - f32( x0 );
    let wy = fy - f32( y0 );
    let c00 = reflScratchRead.value[ reflNeighborTexel( face, x0, y0, side ) ].rgb;
    let c10 = reflScratchRead.value[ reflNeighborTexel( face, x0 + 1, y0, side ) ].rgb;
    let c01 = reflScratchRead.value[ reflNeighborTexel( face, x0, y0 + 1, side ) ].rgb;
    let c11 = reflScratchRead.value[ reflNeighborTexel( face, x0 + 1, y0 + 1, side ) ].rgb;
    return mix( mix( c00, c10, wx ), mix( c01, c11, wx ), wy );
  }
`,
  [directionToFace, neighborTexel] as never,
);

export const importanceGgx = wgslFn(`
  fn reflImportanceGgx( u: vec2f, n: vec3f, alpha: f32 ) -> vec3f {
    let phi = 6.28318530718 * u.x;
    let cosTheta = sqrt( ( 1.0 - u.y ) / ( 1.0 + ( alpha * alpha - 1.0 ) * u.y ) );
    let sinTheta = sqrt( max( 1.0 - cosTheta * cosTheta, 0.0 ) );
    let helper = select( vec3f( 0.0, 1.0, 0.0 ), vec3f( 1.0, 0.0, 0.0 ), abs( n.y ) > 0.99 );
    let tangent = normalize( cross( helper, n ) );
    let bitangent = cross( n, tangent );
    return normalize( tangent * ( cos( phi ) * sinTheta ) + bitangent * ( sin( phi ) * sinTheta ) + n * cosTheta );
  }
`);

export const hammersley = wgslFn(`
  fn reflHammersley( i: u32, count: u32 ) -> vec2f {
    var bits = i;
    bits = ( bits << 16u ) | ( bits >> 16u );
    bits = ( ( bits & 0x55555555u ) << 1u ) | ( ( bits & 0xAAAAAAAAu ) >> 1u );
    bits = ( ( bits & 0x33333333u ) << 2u ) | ( ( bits & 0xCCCCCCCCu ) >> 2u );
    bits = ( ( bits & 0x0F0F0F0Fu ) << 4u ) | ( ( bits & 0xF0F0F0F0u ) >> 4u );
    bits = ( ( bits & 0x00FF00FFu ) << 8u ) | ( ( bits & 0xFF00FF00u ) >> 8u );
    return vec2f( f32( i ) / f32( count ), f32( bits ) * 2.3283064365386963e-10 );
  }
`);
