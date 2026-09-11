export const CAPTURE_SHADE = `
  fn reflCaptureShade(
    hit: SceneHit,
    ray: Ray,
    diffuseTex: texture_2d_array<f32>,
    diffuseSampler: sampler,
    envTex: texture_2d<f32>,
    envSampler: sampler,
    envIntensity: f32,
    skyKnee: f32,
    lightsTex: texture_2d<f32>,
    lightCount: u32,
    lightSamples: u32,
    medium: vec4f,
    emissiveBase: i32,
    emissiveScale: f32,
    probeIrrTex: texture_2d<f32>,
    probeIrrSampler: sampler,
    probeSunTex: texture_2d<f32>,
    probeDistTex: texture_2d<f32>,
    gridOrigin: vec3f,
    gridCell: f32,
    gridDims: vec3f,
    atlasTiles: vec2f,
    probeBias: vec2f,
    probeScales: vec3f,
    probeVisibility: f32,
    look: vec2f,
    dynTrace: f32,
    dynBounds: vec4f,
    rnd: f32
  ) -> vec4f {
    if ( hit.exhausted ) { return vec4f( 0.0, 0.0, 0.0, -1.0 ); }
    if ( !hit.didHit ) {
      let uv = envEquirectUV( ray.direction );
      let hdr = textureSampleLevel( envTex, envSampler, uv, 0.0 ).rgb * envIntensity;
      let lum = dot( hdr, vec3f( 0.2126, 0.7152, 0.0722 ) );
      let sky = select( hdr, hdr * ( skyKnee / max( lum, 1.0e-6 ) ), lum > skyKnee );
      return vec4f( sky, 1.0 );
    }
    let p = ray.origin + ray.direction * hit.dist;
    var n = normalize( hit.normal );
    if ( dot( n, ray.direction ) > 0.0 ) { n = -n; }
    let matId = i32( round( hit.attrib.z ) );
    let albedo = sampleDiffuseArray( diffuseTex, diffuseSampler, hit.attrib.xy, matId, 0.0 );
    let emission = giHitEmissive( diffuseTex, diffuseSampler, hit.attrib.xy, matId, 0.0, emissiveBase, emissiveScale );
    let direct = giShadeHit( lightsTex, p, n, albedo, 0.002, dynTrace, dynBounds, lightCount, lightSamples, rnd, medium, diffuseTex, diffuseSampler );
    let irradiance = reflProbeIrradiance(
      probeIrrTex, probeIrrSampler, probeSunTex, probeDistTex,
      p, n, -ray.direction,
      gridOrigin, gridCell, gridDims, atlasTiles, probeBias, probeScales, probeVisibility
    );
    let indirect = reflArtisticIndirect( irradiance, look.x, look.y ) * albedo;
    let radiance = emission + direct + indirect;
    if ( !all( radiance == radiance ) ) { return vec4f( 0.0, 0.0, 0.0, -2.0 ); }
    if ( any( radiance > vec3f( 65504.0 ) ) ) { return vec4f( 0.0, 0.0, 0.0, -2.0 ); }
    return vec4f( radiance, 1.0 );
  }
`;

export const CAPTURE_KERNEL = `
  fn reflCaptureKernel(
    diffuseTex: texture_2d_array<f32>,
    diffuseSampler: sampler,
    envTex: texture_2d<f32>,
    envSampler: sampler,
    envIntensity: f32,
    skyKnee: f32,
    lightsTex: texture_2d<f32>,
    lightCount: u32,
    lightSamples: u32,
    medium: vec4f,
    emissiveBase: i32,
    emissiveScale: f32,
    probeIrrTex: texture_2d<f32>,
    probeIrrSampler: sampler,
    probeSunTex: texture_2d<f32>,
    probeDistTex: texture_2d<f32>,
    gridOrigin: vec3f,
    gridCell: f32,
    gridDims: vec3f,
    atlasTiles: vec2f,
    probeBias: vec2f,
    probeScales: vec3f,
    probeVisibility: f32,
    look: vec2f,
    dynTrace: f32,
    dynBounds: vec4f,
    anchor: vec3f,
    job: vec4f,
    cubeDims: vec4f,
    budget: vec4f
  ) -> void {
    let jobBase = u32( job.x );
    let jobCount = u32( job.y );
    let slot = u32( job.z );
    let backBank = u32( job.w );
    let side = u32( cubeDims.x );
    let slotCount = u32( cubeDims.y );
    let sampleTarget = u32( cubeDims.z );
    let attemptLimit = u32( cubeDims.w );
    let visitCap = u32( budget.x );
    let sampleStride = u32( budget.y );

    let i = instanceIndex;
    if ( i >= jobCount ) { return; }
    let texel = jobBase + i;
    let baseTexels = 6u * side * side;
    if ( texel >= baseTexels ) { return; }

    let face = texel / ( side * side );
    let inFace = texel % ( side * side );
    let ix = inFace % side;
    let iy = inFace / side;
    let sideF = f32( side );

    let rawIndex = ( slot * baseTexels + texel ) * 3u;
    var c0 = reflRaw.value[ rawIndex ];
    var c1 = reflRaw.value[ rawIndex + 1u ];
    var c2 = reflRaw.value[ rawIndex + 2u ];
    var count = u32( c0.w );
    var flags = u32( c1.w );

    if ( ( flags & REFL_FLAG_CENTER_DEPTH ) == 0u ) {
      let centerS = ( f32( ix ) + 0.5 ) / sideF * 2.0 - 1.0;
      let centerT = ( f32( iy ) + 0.5 ) / sideF * 2.0 - 1.0;
      var centerRay: Ray;
      centerRay.origin = anchor;
      centerRay.direction = reflFaceDirection( face, centerS, centerT );
      let centerHit = traceScene( centerRay, dynTrace, dynBounds, visitCap );
      if ( !centerHit.exhausted ) {
        let known = select( REFL_SKY_DISTANCE, centerHit.dist, centerHit.didHit );
        let kind = select( REFL_FLAG_SKY, REFL_FLAG_HIT, centerHit.didHit );
        flags = flags | REFL_FLAG_CENTER_DEPTH;
        c1.w = f32( flags );
        c2 = vec4f( known, f32( kind ), 0.0, 0.0 );
        reflRaw.value[ rawIndex + 1u ] = c1;
        reflRaw.value[ rawIndex + 2u ] = c2;
      }
    }

    if ( count >= sampleTarget ) { return; }

    var taken = 0u;
    let want = min( sampleStride, sampleTarget - count );
    while ( taken < want ) {
      let sampleIndex = count + taken;
      let s0 = f32( ix ) / sideF * 2.0 - 1.0;
      let s1 = f32( ix + 1u ) / sideF * 2.0 - 1.0;
      let t0 = f32( iy ) / sideF * 2.0 - 1.0;
      let t1 = f32( iy + 1u ) / sideF * 2.0 - 1.0;
      let sNear = select( min( abs( s0 ), abs( s1 ) ), 0.0, s0 * s1 < 0.0 );
      let tNear = select( min( abs( t0 ), abs( t1 ) ), 0.0, t0 * t1 < 0.0 );
      let jMax = reflJacobian( sNear, tNear );

      var accepted = false;
      var s = 0.0;
      var t = 0.0;
      for ( var attempt = 0u; attempt < attemptLimit; attempt = attempt + 1u ) {
        let u = reflHash( texel * 9781u + sampleIndex, attempt * 6151u + 17u );
        let candidateS = mix( s0, s1, u.x );
        let candidateT = mix( t0, t1, u.y );
        let accept = reflHash( texel * 2654u + sampleIndex, attempt * 4099u + 91u ).x;
        if ( accept * jMax <= reflJacobian( candidateS, candidateT ) ) {
          s = candidateS;
          t = candidateT;
          accepted = true;
          break;
        }
      }
      if ( !accepted ) { break; }

      var ray: Ray;
      ray.origin = anchor;
      ray.direction = reflFaceDirection( face, s, t );
      let hit = traceScene( ray, dynTrace, dynBounds, visitCap );
      let shaded = reflCaptureShade(
        hit, ray, diffuseTex, diffuseSampler, envTex, envSampler, envIntensity, skyKnee,
        lightsTex, lightCount, lightSamples, medium, emissiveBase, emissiveScale,
        probeIrrTex, probeIrrSampler, probeSunTex, probeDistTex,
        gridOrigin, gridCell, gridDims, atlasTiles, probeBias, probeScales, probeVisibility,
        look, dynTrace, dynBounds, reflHash( texel, sampleIndex ).y
      );
      if ( shaded.w <= 0.0 ) { break; }

      let n = f32( count + taken ) + 1.0;
      let oldY = dot( c0.rgb, vec3f( 0.2126, 0.7152, 0.0722 ) );
      c0 = vec4f( c0.rgb + ( shaded.rgb - c0.rgb ) / n, 0.0 );
      let sampleY = dot( shaded.rgb, vec3f( 0.2126, 0.7152, 0.0722 ) );
      let newY = dot( c0.rgb, vec3f( 0.2126, 0.7152, 0.0722 ) );
      c1.x = c1.x + ( sampleY - oldY ) * ( sampleY - newY );

      let observed = select( REFL_SKY_DISTANCE, hit.dist, hit.didHit );
      if ( count + taken == 0u ) { c1.y = observed; c1.z = observed; }
      else { c1.y = min( c1.y, observed ); c1.z = max( c1.z, observed ); }
      flags = flags | select( REFL_FLAG_SKY, REFL_FLAG_HIT, hit.didHit );
      taken = taken + 1u;
    }

    if ( taken == 0u ) { return; }
    count = count + taken;
    c0.w = f32( count );
    c1.w = f32( flags );
    reflRaw.value[ rawIndex ] = c0;
    reflRaw.value[ rawIndex + 1u ] = c1;
  }
`;
