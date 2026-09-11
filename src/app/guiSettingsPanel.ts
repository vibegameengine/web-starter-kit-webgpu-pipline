import type GUI from 'lil-gui';

import {
  applyGuiSettings,
  countValues,
  deleteSettings,
  differenceFrom,
  loadGuiSettings,
  panelState,
  readSettings,
  settingsFileName,
  storeSettingsProfile,
  writeSettings,
  SETTINGS_PROFILES,
  type ProfileSource,
  type SettingsProfile,
} from './guiSettings.ts';

const WRITTEN_MS = 2500;
const PROFILE_HINT: Record<SettingsProfile, string> = {
  merged: 'shared file, then this scene on top',
  shared: 'shared file only',
  scene: 'this scene file only',
  off: 'code defaults, no file',
};

type SettingsUi = { showError(error: unknown): void };
type Undo = { label: string; restore: () => Promise<void> } | null;

type Row = { name(text: string): Row; disable(state?: boolean): Row; domElement: HTMLElement };
export type PanelStart = { profile: SettingsProfile; source: ProfileSource };

export function addGuiSettingsControls(gui: GUI, scene: string, start: PanelStart, ui: SettingsUi): void {
  const { profile, source } = start;
  const folder = gui.addFolder('Settings file');
  const state = { profile, inForce: '', sharedFile: '', sceneFile: '' };
  let undo: Undo = null;

  const useRow = folder.add(state, 'profile', SETTINGS_PROFILES).name('use') as unknown as Row;
  describe(useRow, 'Which files this panel starts from. Switching applies at once and is remembered for the next load.');
  (useRow as unknown as { onChange(fn: (v: SettingsProfile) => void): void }).onChange((next: SettingsProfile) => {
    storeSettingsProfile(next);
    void loadGuiSettings(scene, next)
      .then((settings) => applyGuiSettings(gui, settings))
      .then(refresh)
      .catch(ui.showError);
  });

  addReadout(folder, state, 'inForce', 'in force');
  addReadout(folder, state, 'sharedFile', settingsFileName());
  addReadout(folder, state, 'sceneFile', settingsFileName(scene));

  const undoRow = folder.add({ undo: () => runUndo() }, 'undo').name('nothing to undo') as unknown as Row;
  undoRow.disable(true);
  describe(undoRow, 'Puts the last file this panel wrote back exactly as it was before that write.');

  addWriteButton(folder, {
    label: `write ${settingsFileName()}`,
    hint: 'Writes every value in this panel to the shared file, which every scene starts from. The row above puts it back.',
    run: async () => {
      undo = await undoFor(undefined, settingsFileName());
      const settings = panelState(gui);
      await writeSettings(settings);
      return `${countValues(settings)} values written`;
    },
    after: refresh,
    ui,
  });

  addWriteButton(folder, {
    label: `write ${settingsFileName(scene)}`,
    hint: 'Writes the values that differ from the shared file, for this scene alone. Other scenes are untouched. The row above puts it back.',
    run: async () => {
      undo = await undoFor(scene, settingsFileName(scene));
      const overrides = differenceFrom(panelState(gui), await readSettings());
      await writeSettings(overrides, scene);
      return `${countValues(overrides)} overrides written`;
    },
    after: refresh,
    ui,
  });

  void refresh();

  async function undoFor(target: string | undefined, name: string): Promise<Undo> {
    const previous = await readSettings(target);
    return {
      label: `undo write of ${name}`,
      restore: async () => (previous ? writeSettings(previous, target) : deleteSettings(target)),
    };
  }

  function runUndo(): void {
    if (!undo) return;
    void undo.restore().then(() => { undo = null; }).then(refresh).catch(ui.showError);
  }

  async function refresh(): Promise<void> {
    const [shared, local] = await Promise.all([readSettings(), readSettings(scene)]);
    state.inForce = state.profile === profile ? describeStart(profile, source) : PROFILE_HINT[state.profile];
    state.sharedFile = describeFile(countValues(shared), 'value');
    state.sceneFile = describeFile(countValues(local), 'override');
    undoRow.name(undo ? undo.label : 'nothing to undo').disable(!undo);
  }
}

function describeStart(profile: SettingsProfile, source: ProfileSource): string {
  if (source.kind === 'url') return `${PROFILE_HINT[profile]} (${source.parameter})`;
  if (source.kind === 'ablation') return `${PROFILE_HINT[profile]} — URL has ${source.parameters.join(', ')}; add ?settings=1 to use the files`;
  return PROFILE_HINT[profile];
}

function describeFile(count: number, noun: string): string {
  if (!count) return 'not written yet';
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function addReadout<T extends object>(folder: GUI, state: T, key: keyof T & string, label: string): void {
  const row = folder.add(state, key).name(label) as unknown as Row & { listen(): Row };
  row.listen();
  row.disable(true);
}

function describe(row: Row, text: string): void {
  row.domElement.title = text;
}

type WriteButton = {
  label: string;
  hint: string;
  run: () => Promise<string>;
  after: () => Promise<void>;
  ui: SettingsUi;
};

/**
 * @important One press writes. A confirm step was tried first and was worse: the armed
 * label read as an error message, the user pressed once and nothing was saved. Undo is
 * what makes a stray press harmless, so the press itself stays immediate.
 */
function addWriteButton(folder: GUI, button: WriteButton): void {
  const row = folder.add({ press: () => press() }, 'press').name(button.label) as unknown as Row;
  describe(row, button.hint);

  function press(): void {
    void button.run()
      .then(async (result) => {
        await button.after();
        row.name(result);
        window.setTimeout(() => row.name(button.label), WRITTEN_MS);
      })
      .catch(button.ui.showError);
  }
}
