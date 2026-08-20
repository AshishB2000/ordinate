// Hotkey accelerator helpers — platform default + human-readable label
// formatting. Pure (depend only on process.platform). Extracted from main.js as
// a pure structural move; the stateful hotkey:save/label IPC handlers and the
// hotkeyRegistered state stay in main.js (coupled to the capture handler).

// Returns the platform-appropriate default accelerator.
export function platformDefaultHotkey(): string {
  return process.platform === 'darwin' ? 'CommandOrControl+Alt+S' : 'Control+Alt+S';
}

// Convert an Electron accelerator string to a human-readable display label.
// darwin: symbol notation (⌘ ⇧ S); win32/linux: word notation (Ctrl + Alt + S).
export function hotkeyLabel(accelerator: string | null | undefined): string {
  const parts = (accelerator || '').split('+');
  if (process.platform === 'darwin') {
    return parts.map(p => {
      switch (p.toLowerCase()) {
        case 'commandorcontrol': case 'command': case 'cmd': return '⌘';
        case 'shift': return '⇧';
        case 'alt': case 'option': return '⌥';
        case 'control': case 'ctrl': return '⌃';
        default: return p.toUpperCase();
      }
    }).join(' ');
  }
  return parts.map(p => {
    switch (p.toLowerCase()) {
      case 'commandorcontrol': case 'command': case 'cmd':
      case 'control': case 'ctrl': return 'Ctrl';
      case 'shift': return 'Shift';
      case 'alt': case 'option': return 'Alt';
      default: return p.toUpperCase();
    }
  }).join(' + ');
}
