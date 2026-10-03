// The `ipcMain` every src/ipc/*.ts registers its handlers on. Each file imports
// it from here, never from 'electron', so one place decides where handlers go:
// Electron's ipcMain under the desktop app, the RPC registry under the server.
import { ipcMain } from 'electron';

export { ipcMain };
