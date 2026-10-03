// The `ipcMain` every src/ipc/*.ts registers its handlers on. Each file imports
// it from here, never from 'electron', so one place decides where handlers go:
// Electron's ipcMain under the desktop app, the RPC registry anywhere else (the
// server, and plain-Node test scripts).
//
// The Electron require sits INSIDE the branch: the server must never load
// 'electron' (scripts/test-server-boot.ts makes it throw). The type import is
// erased at compile time.
import type { IpcMain } from 'electron';
import { registry } from '../server/rpc';

// The registry implements only handle/on/removeHandler — the members the
// handler files use — so it is cast to Electron's type to keep every
// handler's `(event, …)` signature compiling unchanged.
export const ipcMain: IpcMain = process.versions.electron
  ? (require('electron') as typeof import('electron')).ipcMain
  : (registry as unknown as IpcMain);
