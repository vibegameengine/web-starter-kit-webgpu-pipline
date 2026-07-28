import * as THREE from 'three';

/**
 * Deterministic PCSS soft shadows (WebGL, patches the PCF ShaderChunk).
 *
 * Two stages, both DETERMINISTIC (fixed grids, no random rotation → zero
 * grain, and the footprint always spans many texels → zero staircase):
 *
 *  1. Blocker search — a fixed 5×5 grid finds the average occluder depth.
 *  2. Penumbra filter — a Gaussian-weighted (2R+1)² grid whose radius grows
 *     with the blocker→receiver gap (contact hardening: sharp at the base of
 *     a caster, softening with distance, exactly like UE SMRT).
 *
 * Use renderer.shadowMap.type = THREE.PCFShadowMap (we replace that branch).
 */
export function installSoftShadows(): void {
  const PCSS = /* glsl */ `
      vec2 texelSize = vec2( 1.0 ) / shadowMapSize;

      // ── 1. blocker search (fixed 5×5 grid) ──────────────────────────────
      float searchR = shadowRadius * 4.0; // world softness scale, in texels
      float blockerDepth = 0.0;
      float blockerCount = 0.0;
      for ( int by = -2; by <= 2; by ++ ) {
        for ( int bx = -2; bx <= 2; bx ++ ) {
          vec2 o = vec2( float( bx ), float( by ) ) * texelSize * searchR * 0.5;
          float d = unpackRGBAToDepth( texture2D( shadowMap, shadowCoord.xy + o ) );
          if ( d < shadowCoord.z ) { blockerDepth += d; blockerCount += 1.0; }
        }
      }

      if ( blockerCount < 0.5 ) {
        shadow = 1.0; // fully lit
      } else {
        float avgBlocker = blockerDepth / blockerCount;
        // penumbra grows with receiver→blocker distance (contact hardening)
        float penumbra = ( shadowCoord.z - avgBlocker ) / avgBlocker;
        float filterR = clamp( penumbra * shadowRadius * 40.0, 0.6, 8.0 );

        // ── 2. Gaussian-weighted deterministic filter (7×7) ───────────────
        const float W[7] = float[7]( 1.0, 6.0, 15.0, 20.0, 15.0, 6.0, 1.0 );
        float sum = 0.0;
        float wsum = 0.0;
        for ( int fy = -3; fy <= 3; fy ++ ) {
          for ( int fx = -3; fx <= 3; fx ++ ) {
            float w = W[ fx + 3 ] * W[ fy + 3 ];
            vec2 o = vec2( float( fx ), float( fy ) ) * texelSize * filterR;
            sum += w * texture2DCompare( shadowMap, shadowCoord.xy + o, shadowCoord.z );
            wsum += w;
          }
        }
        shadow = sum / wsum;
      }
  `;

  let chunk = THREE.ShaderChunk.shadowmap_pars_fragment as string;

  const start = chunk.indexOf('#if defined( SHADOWMAP_TYPE_PCF )');
  const end = chunk.indexOf('#elif defined( SHADOWMAP_TYPE_PCF_SOFT )');
  if (start < 0 || end < 0) {
    console.warn('softShadows: shadowmap chunk layout changed, patch skipped');
    return;
  }
  chunk =
    chunk.slice(0, start) +
    '#if defined( SHADOWMAP_TYPE_PCF )\n' +
    PCSS +
    '\n\t\t' +
    chunk.slice(end);

  THREE.ShaderChunk.shadowmap_pars_fragment = chunk;
}
