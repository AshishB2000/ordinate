import { ipcMain, shell, app } from 'electron';
import { providerLogos, agentLogos } from '../icons';

// Shell / logos IPC — synchronous brand-glyph payloads for the sandboxed hub
// preload, external-URL opening, and the macOS System-Settings deep links.
// Extracted from main.js as a pure structural move. No state, no window refs.
export function register() {
  // Synchronous: the sandboxed hub preload can't require simple-icons, so it
  // pulls the brand glyph paths from main at load time (tiny one-shot payload).
  ipcMain.on('provider:logos', (e) => { e.returnValue = providerLogos; });
  ipcMain.on('agent:logos', (e) => { e.returnValue = agentLogos; });

  // App version straight from package.json (via app.getVersion), read once by the
  // hub preload at load. Keeps the About panel's version dynamic — never hardcoded.
  ipcMain.on('app:version', (e) => { e.returnValue = app.getVersion(); });

  ipcMain.on('shell:open', (_e, url: any) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      shell.openExternal(url);
    }
  });

  ipcMain.on('privacy:open-input-monitoring', () => {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent');
  });

  // Open macOS Privacy → Screen Recording settings.
  ipcMain.handle('permission:open-settings', () => {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    );
  });
}
