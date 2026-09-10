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
  type SettingsProfile,
} from './guiSettings.ts';

const CONFIRM_MS = 5000;
const PROFILE_HINT: Record<SettingsProfile, string> = {
  merged: 'shared file, then this scene on top',
  shared: 'shared file only',
  scene: 'this scene file only',
  off: 'code defaults, no file',
};

type SettingsUi = { showError(error: unknown): void };
type Undo = { label: string; restore: () => Promise<void> } | null;

type Row = { name(text: string): Row; disable(state?: boolean): Row; domElement: HTMLElement };

export function addGuiSettingsControls(gui: GUI, scene: string, profile: SettingsProfile, ui: SettingsUi): void {
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

  addConfirmButton(folder, {
    label: `write ${settingsFileName()}`,
    hint: 'Writes every value in this panel to the shared file. Every scene starts from it. Nothing is written until you press twice.',
    describeAction: async () => `overwrite ${countValues(panelState(gui))} values for all scenes?`,
    run: async () => {
      undo = await undoFor(undefined, settingsFileName());
      await writeSettings(panelState(gui));
    },
    after: refresh,
    ui,
  });

  addConfirmButton(folder, {
    label: `write ${settingsFileName(scene)}`,
    hint: 'Writes only the values that differ from the shared file, for this scene alone. Other scenes are untouched. Nothing is written until you press twice.',
    describeAction: async () => `store ${countValues(differenceFrom(panelState(gui), await readSettings()))} overrides for "${scene}"?`,
    run: async () => {
      undo = await undoFor(scene, settingsFileName(scene));
      await writeSettings(differenceFrom(panelState(gui), await readSettings()), scene);
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
    state.inForce = PROFILE_HINT[state.profile];
    state.sharedFile = describeFile(countValues(shared), 'value');
    state.sceneFile = describeFile(countValues(local), 'override');
    undoRow.name(undo ? undo.label : 'nothing to undo').disable(!undo);
  }
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

type ConfirmButton = {
  label: string;
  hint: string;
  describeAction: () => Promise<string>;
  run: () => Promise<void>;
  after: () => Promise<void>;
  ui: SettingsUi;
};

/**
 * @important Both buttons overwrite a file, so the first press only asks: it renames
 * itself to what would be written and waits. A single stray click changes nothing.
 */
function addConfirmButton(folder: GUI, button: ConfirmButton): void {
  const row = folder.add({ press: () => press() }, 'press').name(button.label) as unknown as Row;
  describe(row, button.hint);
  let armed = false;
  let timer = 0;

  function disarm(): void {
    armed = false;
    window.clearTimeout(timer);
    row.name(button.label);
  }

  function press(): void {
    if (armed) {
      disarm();
      void button.run()
        .then(() => { row.name('written'); window.setTimeout(() => row.name(button.label), 1500); })
        .then(button.after)
        .catch(button.ui.showError);
      return;
    }
    void button.describeAction()
      .then((question) => {
        armed = true;
        row.name(`press again: ${question}`);
        timer = window.setTimeout(disarm, CONFIRM_MS);
      })
      .catch(button.ui.showError);
  }
}
