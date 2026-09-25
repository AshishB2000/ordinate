// The application menu — MAIN PROCESS, built from the renderer's command registry.
//
// The app shipped with Electron's default menu, which named nothing the app can
// actually do. The fix is not a second hand-written list: the menu bar, the
// palette, the shortcuts sheet and the keyboard all read ONE registry
// (renderer/hub/commands.ts). The renderer sends it here once at boot; a click
// comes back as a command id on `menu:run`, and the renderer runs it — so a
// menu item can never point at a flow that was renamed or deleted, and its
// accelerator is the same string the keymap matches.
//
// Nothing in a command crosses the boundary except strings: id, title, group
// and accelerator. Main never learns what a command DOES.

import { app, ipcMain, Menu, MenuItemConstructorOptions, BrowserWindow } from 'electron';

interface MenuCommand {
  id: string;
  title: string;
  group: string;
  accelerator: string;
}

/** Which registry groups fill which menu, in the order they appear in it. */
const MENUS: { label: string; groups: string[] }[] = [
  { label: 'File', groups: ['Create', 'Data'] },
  { label: 'View', groups: ['View', 'Navigate'] },
  { label: 'Dashboard', groups: ['Dashboard'] },
  { label: 'Assistant', groups: ['Assistant'] },
  { label: 'Help', groups: ['Help'] },
];

/** Send the id to whichever window the click came from. */
function forward(id: string): void {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send('menu:run', id);
}

function sanitize(raw: unknown): MenuCommand[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c.id === 'string' && typeof c.title === 'string')
    .map((c) => ({
      id: String(c.id),
      title: String(c.title),
      group: String(c.group || ''),
      accelerator: typeof c.accelerator === 'string' ? c.accelerator : '',
    }));
}

// Edit sits after File, with the platform's OWN roles. ⌘Z inside a text field
// means "undo my typing", and a command that took that key would be a data-loss
// bug wearing a shortcut — the dashboard's Undo is a registry command bound in
// the renderer and guarded to the editor.
const EDIT_MENU: MenuItemConstructorOptions = {
  label: 'Edit',
  submenu: [
    { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
    { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
  ],
};

/** The app menu (macOS) — the only thing every template starts with. */
function base(): MenuItemConstructorOptions[] {
  return process.platform === 'darwin' ? [{ role: 'appMenu' }] : [];
}

function build(commands: MenuCommand[]): void {
  const template: MenuItemConstructorOptions[] = base();

  for (const menu of MENUS) {
    const items: MenuItemConstructorOptions[] = [];
    for (const group of menu.groups) {
      const rows = commands.filter((c) => c.group === group);
      if (!rows.length) continue;
      if (items.length) items.push({ type: 'separator' });
      for (const c of rows) {
        items.push({ label: c.title, accelerator: c.accelerator || undefined, click: () => forward(c.id) });
      }
    }
    if (!items.length) continue;
    template.push({ label: menu.label, submenu: items });
    if (menu.label === 'File') template.push(EDIT_MENU);
  }

  if (template.length < 2) return; // nothing registered — leave the default menu alone
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function register(): void {
  // The BOOT menu: app + Edit, and nothing else, until the renderer sends the
  // registry. Electron's DEFAULT menu is live until then, and its Window menu
  // binds ⌘W to Close Window — but ⌘W closes a TAB in this app (tabStrip.ts),
  // so a ⌘W pressed during the splash would take the whole window with it.
  // Installed on ready, before any window exists; menu:build replaces it.
  void app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([...base(), EDIT_MENU]));
  });
  ipcMain.handle('menu:build', (_e, commands: unknown) => {
    try {
      const list = sanitize(commands);
      if (!list.length) return { ok: false, error: 'no commands' };
      build(list);
      return { ok: true, count: list.length };
    } catch (err: any) {
      // A broken menu must not take the window with it.
      console.warn('[menu] build failed —', err?.message || err);
      return { ok: false, error: err?.message || 'menu build failed' };
    }
  });
}
