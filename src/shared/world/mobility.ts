import type { Object3D } from 'three/webgpu';

/**
 * Mobility — lifted from Unreal, because every cache in this pipeline keys off it.
 *
 * The enum itself is trivial; the rule attached to it is the point:
 *   Static     — may be cached. Shadow depth, GI integration, sky visibility.
 *   Stationary — direct light is dynamic, indirect light is cached. Our sun.
 *   Movable    — nothing about it may be cached.
 *
 * UE goes one step further and reclassifies at runtime (a Movable mesh that never
 * actually moves migrates into the static shadow cache). We leave room for that:
 * classification lives in the layer mask, which can be changed at any time, and
 * `WorldState.markStaticGeoDirty()` is the single signal every cache listens to.
 */
export const Mobility = {
  Static: 0,
  Stationary: 1,
  Movable: 2,
} as const;
export type Mobility = (typeof Mobility)[keyof typeof Mobility];

/**
 * Render layers.
 *
 * Shadow cameras select casters purely by layer mask, which is what keeps the
 * static/dynamic shadow split a one-line change at render time rather than a
 * scene-graph traversal every frame.
 */
export const Layer = {
  /** Everything the beauty pass draws. */
  Default: 0,
  /** Cached shadow depth: terrain, rock, trunks, architecture. */
  StaticCaster: 1,
  /** Re-rendered every frame: player, props, wind foliage, VFX. */
  DynamicCaster: 2,
  /** What the BVH tracer integrates against when refreshing the GI cache. */
  GiStatic: 3,
  /** Debug gizmos — visible to the viewport camera, invisible to every other pass. */
  Debug: 4,
  /**
   * Drawn by the frame graph's overlay pass, after the composite, with the scene's
   * colour and depth as inputs: water and other single-layer translucents. No camera
   * that feeds the G-buffer or the GI ever enables it.
   */
  Overlay: 5,
} as const;
export type Layer = (typeof Layer)[keyof typeof Layer];

export interface MobilityOptions {
  /** Does this object write into a shadow map at all? Defaults to true. */
  castShadow?: boolean;
  /** Does this object take part in the static GI cache? Defaults to true for Static. */
  contributesToStaticGi?: boolean;
  /**
   * Force the dynamic caster layer even for Static mobility. Set this for anything
   * whose vertices move in the shader (wind / WPO): the geometry is nominally
   * static but its shadow silhouette changes every frame, so caching it is a lie.
   * UE hits the same wall — WPO materials always invalidate cached pages.
   */
  animatesVertices?: boolean;
}

/**
 * Tags an object (and its descendants) with a mobility class and assigns the
 * matching render layers. This is the only sanctioned way to put something in the
 * scene — an untagged object casts no shadow and contributes no GI, by design,
 * so that omissions are visible rather than silently expensive.
 */
export function applyMobility(
  root: Object3D,
  mobility: Mobility,
  options: MobilityOptions = {},
): void {
  const {
    castShadow = true,
    contributesToStaticGi = mobility === Mobility.Static,
    animatesVertices = false,
  } = options;

  // Vertices that move in the shader can never live in a cached shadow layer.
  const cacheable = mobility === Mobility.Static && !animatesVertices;
  const casterLayer = cacheable ? Layer.StaticCaster : Layer.DynamicCaster;

  root.traverse((object) => {
    object.userData.mobility = mobility;

    object.layers.set(Layer.Default);
    if (castShadow) object.layers.enable(casterLayer);
    if (contributesToStaticGi) object.layers.enable(Layer.GiStatic);

    const renderable = object as Object3D & {
      isMesh?: boolean;
      castShadow: boolean;
      receiveShadow: boolean;
    };
    if (renderable.isMesh) {
      renderable.castShadow = castShadow;
      renderable.receiveShadow = true;
    }
  });
}

/** Layer mask helper for shadow cameras: `camera.layers.mask = maskOf(Layer.StaticCaster)`. */
export function maskOf(...layers: Layer[]): number {
  let mask = 0;
  for (const layer of layers) mask |= 1 << layer;
  return mask >>> 0;
}
