// Where the app keeps its files. Every former `app.getPath(...)` call goes
// through here, so the desktop and the server can disagree about the answer:
// Electron's own folders under the desktop app; under the server, a per-org
// directory below DATA_DIR (resolved from the request context).

function electronPath(name: 'userData' | 'downloads' | 'temp' | 'documents'): string {
  // Lazy: the server never loads Electron.
  return (require('electron') as typeof import('electron')).app.getPath(name);
}

export function userData(): string { return electronPath('userData'); }
export function downloads(): string { return electronPath('downloads'); }
export function temp(): string { return electronPath('temp'); }
export function documents(): string { return electronPath('documents'); }
