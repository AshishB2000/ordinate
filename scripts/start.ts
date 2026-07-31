// Dev launcher for `npm start` — cross-platform.
//
// We must ensure ELECTRON_RUN_AS_NODE is ABSENT so `electron .` boots the GUI
// app, not a bare Node process. It gets inherited as "1" when npm/electron is
// spawned from a Node context; leaving it set makes Electron run as Node.
//
// The Unix idiom `ELECTRON_RUN_AS_NODE= electron .` clears it, but the
// cross-env equivalent only sets it to an EMPTY STRING. On Windows an
// empty-but-present value still trips Electron's run-as-node path and crashes
// with `Assertion failed: (isolate_data->snapshot_data()) != nullptr` in
// node::CreateEnvironment. Deleting the key (below) unsets it on both platforms.

import { spawn } from 'child_process';
// Keep require here: in a plain-Node context require('electron') returns the
// PATH STRING to the Electron binary, not the electron API module.
const electron: string = require('electron');

delete process.env.ELECTRON_RUN_AS_NODE;

const args = ['.', '--password-store=basic', ...process.argv.slice(2)];
const child = spawn(electron, args, { stdio: 'inherit' });
child.on('close', (code) => process.exit(code == null ? 0 : code));
