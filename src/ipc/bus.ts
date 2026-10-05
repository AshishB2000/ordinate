// The `ipcMain` every src/ipc/*.ts registers its handlers on: the RPC registry
// (src/server/rpc.ts). Each file imports it from here, so one place decides
// where handlers go.
//
// The registry implements only handle/on/removeHandler — the members the
// handler files use — under the name and shape the handler files were written
// against, so every handler's `(event, …)` signature compiles unchanged.
import { registry } from '../server/rpc';

export const ipcMain = registry;
