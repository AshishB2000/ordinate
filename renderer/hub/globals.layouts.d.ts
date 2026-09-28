// Additive globals for layouts for every size (depth round 6), kept apart from
// the shared globals.d.ts so concurrent branches do not collide on it. Only
// symbols that are NOT function declarations need one here — a classic
// script's functions are visible to the others through the shared program.

// renderer/hub/sizeLayout.ts attaches this to window (UMD, the cardModel pattern).
// ponytail: its shapes are validated inside the module; callers treat it as a namespace
declare const sizeLayout: any;
