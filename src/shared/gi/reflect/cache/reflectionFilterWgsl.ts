export const MIP_OFFSET = `
  fn reflMipOffset( side: u32, level: u32 ) -> u32 {
    var offset = 0u;
    var s = side;
    for ( var m = 0u; m < level; m = m + 1u ) {
      offset = offset + 6u * s * s;
      s = s >> 1u;
    }
    return offset;
  }
`;

export const FREEZE_KERNEL = `
  fn reflFreezeKernel( job: vec4f, cubeDims: vec4f ) -> void {
    let slot = u32( job.x );
    let backBank = u32( job.y );
    let slotCount = u32( job.z );
    let side = u32( cubeDims.x );
    let baseTexels = 6u * side * side;
    let i = instanceIndex;
    if ( i >= baseTexels ) { return; }
    let rawIndex = ( slot * baseTexels + i ) * 3u;
    let c0 = reflRawRead.value[ rawIndex ];
    let c1 = reflRawRead.value[ rawIndex + 1u ];
    let c2 = reflRawRead.value[ rawIndex + 2u ];
    reflScratch.value[ i ] = vec4f( c0.rgb, c0.w );
    let depthIndex = ( backBank * slotCount + slot ) * baseTexels + i;
    reflDepth.value[ depthIndex ] = vec4f( c2.x, c1.y, c1.z, c2.y );
  }
`;

export const BASE_COPY_KERNEL = `
  fn reflBaseCopyKernel( job: vec4f, cubeDims: vec4f ) -> void {
    let slot = u32( job.x );
    let backBank = u32( job.y );
    let slotCount = u32( job.z );
    let chainTexels = u32( job.w );
    let side = u32( cubeDims.x );
    let baseTexels = 6u * side * side;
    let i = instanceIndex;
    if ( i >= baseTexels ) { return; }
    let writeIndex = ( backBank * slotCount + slot ) * chainTexels + i;
    reflRadiance.value[ writeIndex ] = reflScratchRead.value[ i ];
  }
`;

export const PREFILTER_KERNEL = `
  fn reflPrefilterKernel( job: vec4f, cubeDims: vec4f, filterArgs: vec4f ) -> void {
    let slot = u32( job.x );
    let backBank = u32( job.y );
    let slotCount = u32( job.z );
    let chainTexels = u32( job.w );
    let baseSide = u32( cubeDims.x );
    let level = u32( cubeDims.y );
    let levelSide = u32( cubeDims.z );
    let sampleCount = u32( cubeDims.w );
    let roughness = filterArgs.x;

    let i = instanceIndex;
    let levelTexels = 6u * levelSide * levelSide;
    if ( i >= levelTexels ) { return; }
    let face = i / ( levelSide * levelSide );
    let inFace = i % ( levelSide * levelSide );
    let sideF = f32( levelSide );
    let s = ( f32( inFace % levelSide ) + 0.5 ) / sideF * 2.0 - 1.0;
    let t = ( f32( inFace / levelSide ) + 0.5 ) / sideF * 2.0 - 1.0;
    let n = reflFaceDirection( face, s, t );

    let writeIndex = ( backBank * slotCount + slot ) * chainTexels + reflMipOffset( baseSide, level ) + i;
    if ( roughness <= 0.0 ) {
      reflRadiance.value[ writeIndex ] = vec4f( reflSampleScratch( n, i32( baseSide ) ), 1.0 );
      return;
    }

    let alpha = roughness * roughness;
    var sum = vec3f( 0.0 );
    var weight = 0.0;
    for ( var k = 0u; k < sampleCount; k = k + 1u ) {
      let u = reflHammersley( k, sampleCount );
      let h = reflImportanceGgx( u, n, alpha );
      let l = normalize( 2.0 * dot( n, h ) * h - n );
      let nDotL = dot( n, l );
      if ( nDotL > 0.0 ) {
        sum = sum + reflSampleScratch( l, i32( baseSide ) ) * nDotL;
        weight = weight + nDotL;
      }
    }
    reflRadiance.value[ writeIndex ] = vec4f( sum / max( weight, 1.0e-6 ), 1.0 );
  }
`;

export const LANE_KERNEL = `
  fn reflLaneKernel( job: vec4f, cubeDims: vec4f ) -> void {
    let slot = u32( job.x );
    let side = u32( cubeDims.x );
    let baseTexels = 6u * side * side;
    let lanes = u32( cubeDims.y );
    let i = instanceIndex;
    if ( i >= lanes ) { return; }
    let perLane = ( baseTexels + lanes - 1u ) / lanes;
    let start = i * perLane;
    let end = min( start + perLane, baseTexels );
    var minCount = 1.0e9;
    var covered = 0.0;
    var depthCovered = 0.0;
    var total = 0.0;
    for ( var texel = start; texel < end; texel = texel + 1u ) {
      let rawIndex = ( slot * baseTexels + texel ) * 3u;
      let c0 = reflRawRead.value[ rawIndex ];
      let c1 = reflRawRead.value[ rawIndex + 1u ];
      minCount = min( minCount, c0.w );
      covered = covered + select( 0.0, 1.0, c0.w > 0.0 );
      depthCovered = depthCovered + select( 0.0, 1.0, ( u32( c1.w ) & REFL_FLAG_CENTER_DEPTH ) != 0u );
      total = total + c0.w;
    }
    if ( start >= end ) { minCount = 1.0e9; }
    reflLanes.value[ i ] = vec4f( minCount, covered, depthCovered, total );
  }
`;

export const REDUCE_KERNEL = `
  fn reflReduceKernel( cubeDims: vec4f ) -> void {
    if ( instanceIndex >= 1u ) { return; }
    let lanes = u32( cubeDims.y );
    var minCount = 1.0e9;
    var covered = 0.0;
    var depthCovered = 0.0;
    var total = 0.0;
    for ( var i = 0u; i < lanes; i = i + 1u ) {
      let lane = reflLanesRead.value[ i ];
      minCount = min( minCount, lane.x );
      covered = covered + lane.y;
      depthCovered = depthCovered + lane.z;
      total = total + lane.w;
    }
    reflStats.value[ 0u ] = minCount;
    reflStats.value[ 1u ] = covered;
    reflStats.value[ 2u ] = depthCovered;
    reflStats.value[ 3u ] = total;
  }
`;
