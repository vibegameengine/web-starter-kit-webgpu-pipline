import type { GuiSettings } from '../../app/guiSettings.ts';

export interface SavedLighting {
  bakePasses?: number;
  atlasIntensity?: number;
  probeIntensity?: number;
  environmentIntensity?: number;
}

const LIVE_SURFEL_FOLDERS = ['GI (live surfels)', 'GI (surfel)'];

function numberAt(settings: GuiSettings | null, folders: string[], control: string): number | undefined {
  for (const folder of folders) {
    const value = settings?.folders?.[folder]?.controllers?.[control];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

/* @important The bake reads these before it runs, not after the panel is built. lil-gui
   controls for lighting are created after `staticLight.prepare()`, and the saved profile is
   applied to controls that exist - so a first fresh bake used the code defaults while the
   panel showed the saved numbers, and the two disagreed for the rest of the session. */
export function savedLighting(settings: GuiSettings | null): SavedLighting {
  return {
    bakePasses: numberAt(settings, ['GI bake'], 'lightmap passes'),
    atlasIntensity: numberAt(settings, ['Lighting'], 'atlas mul'),
    probeIntensity: numberAt(settings, ['Lighting'], 'probe mul'),
    environmentIntensity: numberAt(settings, LIVE_SURFEL_FOLDERS, 'env'),
  };
}
