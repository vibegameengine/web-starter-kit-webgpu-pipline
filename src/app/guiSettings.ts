import type GUI from 'lil-gui';

const ROUTE = '/__gui_settings';
const NAVIGATION_KEYS = new Set(['scene', 'cam', 'hud', 'settings']);
const PROFILE_STORAGE_KEY = 'elderwood.guiSettingsProfile';
const SETTINGS_FOLDER = 'Settings file';

export type GuiSettings = { controllers: Record<string, unknown>; folders: Record<string, GuiSettings> };
export type SettingsProfile = 'merged' | 'shared' | 'scene' | 'off';

export const SETTINGS_PROFILES: SettingsProfile[] = ['merged', 'shared', 'scene', 'off'];

export function settingsSceneName(params: URLSearchParams): string {
  return params.get('scene') ?? 'default';
}

export function settingsFileName(scene?: string): string {
  return scene ? `gui-settings.${scene}.json` : 'gui-settings.json';
}

/**
 * @important A check's URL parameters (`?fog=0`, `?aa=none`) are ablations written
 * against the code defaults, so any parameter beyond scene/camera selection falls back
 * to `off`. `?settings=merged|shared|scene|off` (`1`/`0` for the first and last) is the
 * explicit override, and without one the panel's own dropdown choice is used.
 */
export function settingsProfile(params: URLSearchParams): SettingsProfile {
  const forced = params.get('settings');
  if (forced === '1') return 'merged';
  if (forced === '0') return 'off';
  if (SETTINGS_PROFILES.includes(forced as SettingsProfile)) return forced as SettingsProfile;
  for (const key of params.keys()) if (!NAVIGATION_KEYS.has(key)) return 'off';
  return storedProfile();
}

function storedProfile(): SettingsProfile {
  try {
    const stored = window.localStorage.getItem(PROFILE_STORAGE_KEY) as SettingsProfile | null;
    return stored && SETTINGS_PROFILES.includes(stored) ? stored : 'merged';
  } catch {
    return 'merged';
  }
}

export function storeSettingsProfile(profile: SettingsProfile): void {
  try {
    window.localStorage.setItem(PROFILE_STORAGE_KEY, profile);
  } catch {
    return;
  }
}

function routeFor(scene?: string): string {
  return scene ? `${ROUTE}?scene=${encodeURIComponent(scene)}` : ROUTE;
}

export async function readSettings(scene?: string): Promise<GuiSettings | null> {
  const response = await fetch(routeFor(scene), { cache: 'no-store' });
  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) throw new Error(`GUI settings: HTTP ${response.status}`);
  return (await response.json()) as GuiSettings;
}

export async function writeSettings(settings: GuiSettings, scene?: string): Promise<void> {
  const response = await fetch(routeFor(scene), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!response.ok) throw new Error(`GUI settings not saved: HTTP ${response.status} ${await response.text()}`);
}

export async function deleteSettings(scene?: string): Promise<void> {
  const response = await fetch(routeFor(scene), { method: 'DELETE' });
  if (!response.ok) throw new Error(`GUI settings not removed: HTTP ${response.status}`);
}

function mergeSettings(base: GuiSettings | null, override: GuiSettings | null): GuiSettings | null {
  if (!base) return override;
  if (!override) return base;
  const folders: Record<string, GuiSettings> = { ...base.folders };
  for (const [title, child] of Object.entries(override.folders ?? {})) {
    folders[title] = mergeSettings(base.folders?.[title] ?? null, child) as GuiSettings;
  }
  return { controllers: { ...base.controllers, ...override.controllers }, folders };
}

export async function loadGuiSettings(scene: string, profile: SettingsProfile): Promise<GuiSettings | null> {
  if (profile === 'off') return null;
  if (profile === 'shared') return readSettings();
  if (profile === 'scene') return readSettings(scene);
  const [shared, local] = await Promise.all([readSettings(), readSettings(scene)]);
  return mergeSettings(shared, local);
}

/**
 * @important The panel's own folder is stripped from every file it writes and reads.
 * Storing the `use` dropdown would make a load reset it, which fires its own onChange
 * and reloads the previous scheme: the panel would snap back on every switch.
 */
export function withoutOwnFolder(settings: GuiSettings): GuiSettings {
  const folders = { ...settings.folders };
  delete folders[SETTINGS_FOLDER];
  return { controllers: settings.controllers ?? {}, folders };
}

export function applyGuiSettings(gui: GUI, settings: GuiSettings | null): void {
  if (settings) gui.load(withoutOwnFolder(settings), true);
}

export function panelState(gui: GUI): GuiSettings {
  return withoutOwnFolder(gui.save(true) as GuiSettings);
}

/**
 * @important The scene file keeps only what differs from the shared one, so a later
 * edit to a shared value still reaches every scene that did not override it.
 */
export function differenceFrom(current: GuiSettings, shared: GuiSettings | null): GuiSettings {
  const controllers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(current.controllers ?? {})) {
    if (!shared || !(name in (shared.controllers ?? {})) || shared.controllers[name] !== value) controllers[name] = value;
  }
  const folders: Record<string, GuiSettings> = {};
  for (const [title, child] of Object.entries(current.folders ?? {})) {
    const nested = differenceFrom(child, shared?.folders?.[title] ?? null);
    if (Object.keys(nested.controllers).length || Object.keys(nested.folders).length) folders[title] = nested;
  }
  return { controllers, folders };
}

export function countValues(settings: GuiSettings | null): number {
  if (!settings) return 0;
  let total = Object.keys(settings.controllers ?? {}).length;
  for (const child of Object.values(settings.folders ?? {})) total += countValues(child);
  return total;
}
