import { wgslFn } from 'three/tsl';

export const probeIrradianceWgsl = wgslFn(`
  fn reflProbeIrradiance(
    irrTex: texture_2d<f32>,
    irrSampler: sampler,
    sunTex: texture_2d<f32>,
    distTex: texture_2d<f32>,
    p: vec3f,
    n: vec3f,
    toViewer: vec3f,
    gridOrigin: vec3f,
    gridCell: f32,
    gridDims: vec3f,
    atlasTiles: vec2f,
    bias: vec2f,
    scales: vec3f,
    visibilityTest: f32
  ) -> vec3f {
    let biased = p + n * bias.x + toViewer * bias.y;
    let local = ( biased - gridOrigin ) / gridCell;
    let maxCell = gridDims - vec3f( 1.0 );
    let base = clamp( floor( local ), vec3f( 0.0 ), maxCell - vec3f( 1.0 ) );
    let alpha = clamp( local - base, vec3f( 0.0 ), vec3f( 1.0 ) );
    let nx = gridDims.x;
    let ny = gridDims.y;
    var sum = vec3f( 0.0 );
    var weightSum = 0.0;
    for ( var corner = 0u; corner < 8u; corner = corner + 1u ) {
      let o = vec3f( f32( corner & 1u ), f32( ( corner >> 1u ) & 1u ), f32( ( corner >> 2u ) & 1u ) );
      let coord = base + o;
      let index = u32( coord.x + coord.y * nx + coord.z * nx * ny );
      let record = probeRecords.value[ index ];
      let probePos = gridOrigin + coord * gridCell + record.xyz;
      let trilinear = ( vec3f( 1.0 ) - alpha ) * ( vec3f( 1.0 ) - o ) + alpha * o;
      let dirToProbe = normalize( probePos - p );
      let wrap = ( dot( dirToProbe, n ) + 1.0 ) * 0.5;
      var weight = wrap * wrap + 0.2;
      let toBiased = biased - probePos;
      let dist = length( toBiased );
      let dirFromProbe = toBiased / max( dist, 1.0e-4 );
      let distUv = reflProbeTileUv( f32( index ), reflOctEncode( dirFromProbe ), 16.0, atlasTiles );
      let moments = textureSampleLevel( distTex, irrSampler, distUv, 0.0 ).xy;
      let variance = abs( moments.x * moments.x - moments.y );
      let excess = max( dist - moments.x, 0.0 );
      let chebyshev = variance / max( variance + excess * excess, 1.0e-6 );
      let visible = select( 1.0, max( chebyshev * chebyshev * chebyshev, 0.05 ), dist > moments.x );
      weight = weight * select( 1.0, visible, visibilityTest > 0.5 );
      let state = record.w - floor( record.w / 4.0 ) * 4.0;
      let accepted = state > 0.5;
      let crush = select( 1.0, weight * weight / 0.04, weight < 0.2 );
      weight = select( 0.0, max( weight * crush * trilinear.x * trilinear.y * trilinear.z, 1.0e-5 ), accepted );
      let irrUv = reflProbeTileUv( f32( index ), reflOctEncode( n ), 8.0, atlasTiles );
      let irr = textureSampleLevel( irrTex, irrSampler, irrUv, 0.0 ).rgb
              + textureSampleLevel( sunTex, irrSampler, irrUv, 0.0 ).rgb * scales.y;
      sum = sum + irr * weight;
      weightSum = weightSum + weight;
    }
    if ( weightSum <= 1.0e-6 ) { return vec3f( 0.0 ); }
    return sum / weightSum * scales.x;
  }
`);

export const probeTileUv = wgslFn(`
  fn reflProbeTileUv( probe: f32, oct: vec2f, side: f32, atlasTiles: vec2f ) -> vec2f {
    let tile = side + 2.0;
    let tx = floor( probe - floor( probe / atlasTiles.x ) * atlasTiles.x );
    let ty = floor( probe / atlasTiles.x );
    let texel = vec2f( tx, ty ) * tile + vec2f( 1.0 ) + oct * side;
    return texel / ( atlasTiles * tile );
  }
`);

export const octEncodeWgsl = wgslFn(`
  fn reflOctEncode( direction: vec3f ) -> vec2f {
    let d = direction / max( abs( direction.x ) + abs( direction.y ) + abs( direction.z ), 1.0e-6 );
    let folded = vec2f(
      ( 1.0 - abs( d.y ) ) * select( -1.0, 1.0, d.x >= 0.0 ),
      ( 1.0 - abs( d.x ) ) * select( -1.0, 1.0, d.y >= 0.0 )
    );
    let xy = select( d.xy, folded, d.z < 0.0 );
    return xy * 0.5 + vec2f( 0.5 );
  }
`);

export const artisticIndirectWgsl = wgslFn(`
  fn reflArtisticIndirect( irradiance: vec3f, gain: f32, chroma: f32 ) -> vec3f {
    let lit = irradiance * gain;
    let grey = dot( lit, vec3f( 0.2126, 0.7152, 0.0722 ) );
    return mix( vec3f( grey ), lit, chroma );
  }
`);
