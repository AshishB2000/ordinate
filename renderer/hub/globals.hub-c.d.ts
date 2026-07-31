// Additive globals for the hub-c conversion group (do not fold into the shared
// globals.d.ts while groups convert concurrently).
//
// geoMatch.ts is a classic script that runtime-probes `module` to pick between
// a CommonJS export (Node self-check via scripts/test-geo-match.js) and window
// globals. The renderer tsconfig deliberately has NO Node types, so `module`
// must be declared here for that probe to type-check.
declare var module: any; // ponytail: only existence-probed at runtime, never worth typing
