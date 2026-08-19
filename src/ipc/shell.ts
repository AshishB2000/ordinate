import { ipcMain, shell, app } from 'electron';
import * as os from 'os';
import { providerLogos, agentLogos, connectorLogos } from '../icons';

// Shell / logos IPC — synchronous brand-glyph payloads for the sandboxed hub
// preload, external-URL opening, and the macOS System-Settings deep links.
// Extracted from main.js as a pure structural move. No state, no window refs.
export function register() {
  // Synchronous: the sandboxed hub preload can't require simple-icons, so it
  // pulls the brand glyph paths from main at load time (tiny one-shot payload).
  ipcMain.on('provider:logos', (e) => { e.returnValue = providerLogos; });
  ipcMain.on('agent:logos', (e) => { e.returnValue = agentLogos; });
  ipcMain.on('connector:logos', (e) => { e.returnValue = connectorLogos; });

  // App version straight from package.json (via app.getVersion), read once by the
  // hub preload at load. Keeps the About panel's version dynamic — never hardcoded.
  ipcMain.on('app:version', (e) => { e.returnValue = app.getVersion(); });

  // The OS account's username, first letter capitalised, for Ask's greeting —
  // display only, it never reaches a path, a prompt or the network. '' on any
  // failure (os.userInfo throws on some locked-down accounts), and the renderer
  // treats '' as "no name": it falls back to the timeless greeting.
  ipcMain.handle('app:userName', () => {
    try {
      const raw = String(os.userInfo().username || '').trim();
      return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '';
    } catch (_) {
      return '';
    }
  });

  ipcMain.on('shell:open', (_e, url: any) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      void shell.openExternal(url);
    }
  });

  ipcMain.on('privacy:open-input-monitoring', () => {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent');
  });

  // Open macOS Privacy → Screen Recording settings.
  ipcMain.handle('permission:open-settings', () => {
    void shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    );
  });
}
