import * as THREE from 'three/webgpu';

export interface LightingProvenance {
  lightingRevision: string;
  environmentId: string;
  sunDirection: [number, number, number];
  sunIntensity: number;
  sunColor: [number, number, number];
  transportSettingsHash: string;
}

export type ProvenanceState = 'valid' | 'stale' | 'unknown';

export interface ProvenanceStatus {
  state: ProvenanceState;
  reasons: string[];
}

const LIGHTING_REVISION = 'look-1';
const SUN_ANGLE_TOLERANCE_DEG = 0.25;
const SUN_INTENSITY_TOLERANCE = 0.01;
const SUN_COLOR_TOLERANCE = 1 / 255;
const ENVIRONMENT_DIGEST_STRIDE = 64;

const hex = (data: Uint8Array) => Array.from(data, (value) => value.toString(16).padStart(2, '0')).join('');

async function digestOf(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

/* @important The environment's identity is a digest of its texels, not its URL: two scenes
   can point at the same path while one of them has had its panorama replaced on disk, and a
   bake baked under the old sky must not claim to be valid under the new one. Every 64th
   texel keeps a 2048x1024 panorama's digest at a few milliseconds. */
export async function environmentDigest(texture: THREE.DataTexture | null): Promise<string> {
  const data = texture?.image?.data as ArrayLike<number> | undefined;
  if (!data) return 'none';
  const samples: number[] = [];
  for (let index = 0; index < data.length; index += 4 * ENVIRONMENT_DIGEST_STRIDE) samples.push(Number(data[index]), Number(data[index + 1]), Number(data[index + 2]));
  return `${texture?.image?.width}x${texture?.image?.height}:${(await digestOf(samples.join(','))).slice(0, 16)}`;
}

export async function transportDigest(settings: Record<string, string | number | boolean>): Promise<string> {
  const ordered = Object.keys(settings).sort().map((key) => `${key}=${settings[key]}`).join(';');
  return (await digestOf(ordered)).slice(0, 16);
}

export function captureLightingProvenance(sun: THREE.DirectionalLight, environmentId: string, transportSettingsHash: string): LightingProvenance {
  const direction = sun.position.clone().normalize();
  return {
    lightingRevision: LIGHTING_REVISION,
    environmentId,
    sunDirection: [direction.x, direction.y, direction.z],
    sunIntensity: sun.intensity,
    sunColor: [sun.color.r, sun.color.g, sun.color.b],
    transportSettingsHash,
  };
}

function sunAngleBetween(a: LightingProvenance, b: LightingProvenance): number {
  const dot = a.sunDirection[0] * b.sunDirection[0] + a.sunDirection[1] * b.sunDirection[1] + a.sunDirection[2] * b.sunDirection[2];
  return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
}

/* @important Comparison only reports; it never deletes a bake, rewrites one or starts
   another. A person presses "re-bake now" when the reasons here say the indirect light no
   longer belongs to the light in the scene. */
export function compareLightingProvenance(baked: LightingProvenance | null, current: LightingProvenance): ProvenanceStatus {
  if (!baked) return { state: 'unknown', reasons: ['the saved bake carries no provenance'] };
  const reasons: string[] = [];
  if (baked.lightingRevision !== current.lightingRevision) reasons.push(`baked by lighting revision ${baked.lightingRevision}, this build is ${current.lightingRevision}`);
  if (baked.environmentId !== current.environmentId) reasons.push('the environment panorama is not the one it was baked under');
  const angle = sunAngleBetween(baked, current);
  if (angle > SUN_ANGLE_TOLERANCE_DEG) reasons.push(`the sun moved ${angle.toFixed(2)}°`);
  const intensityRatio = current.sunIntensity / (baked.sunIntensity || 1);
  if (Math.abs(intensityRatio - 1) > SUN_INTENSITY_TOLERANCE) reasons.push(`sun intensity ${baked.sunIntensity.toFixed(3)} → ${current.sunIntensity.toFixed(3)}`);
  if (baked.sunColor.some((channel, index) => Math.abs(channel - current.sunColor[index]) > SUN_COLOR_TOLERANCE)) reasons.push('the sun colour changed');
  if (baked.transportSettingsHash !== current.transportSettingsHash) reasons.push('the transport settings changed');
  return reasons.length ? { state: 'stale', reasons } : { state: 'valid', reasons: [] };
}

export function describeProvenance(status: ProvenanceStatus): string {
  if (status.state === 'valid') return 'valid';
  if (status.state === 'unknown') return 'provenance unknown';
  return `stale: ${status.reasons.join('; ')}`;
}
