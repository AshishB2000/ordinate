// The note the number audit appends to an answer that states a figure the app did not compute (src/ipc/copilot.ts `guardAnswer`).
// Its own file so the issues board can find the MARKER in a stored turn without importing the ask path.
export const GUARD_NOTE = 'Contains a figure the app did not compute: ';
