export { ReflectionCache, type ReflectionCounters } from './reflectionCache.ts';
export { ReflectionSampler, type ReflectionProvider, type ReflectionSurface, type ReflectionLookup } from './reflectionSampler.ts';
export { type CaptureSources } from './reflectionPasses.ts';
export {
  DEFAULT_REFLECTION_CACHE_SETTINGS,
  faceLayout,
  reflectionMemory,
  type BoxProxy,
  type CaptureMode,
  type ReflectionCacheSettings,
  type ReflectionMode,
  type ReflectionVolume,
  type SphereProxy,
} from './reflectionTypes.ts';
export { deriveReflectionVolume } from './reflectionVolumes.ts';
