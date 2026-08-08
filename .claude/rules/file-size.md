# File size

A source file over **500 lines** is a smell; over **800** it must be split before more is added to
it. One file = one job — if you cannot name a file's job in a short phrase without "and", it is two
files.

Renderer splits are mechanical, and all four steps are required or the app silently loses a feature:
new `renderer/hub/<name>.ts` → `<script src="<name>.js">` in `index.html` in dependency order →
shared symbols declared in `globals.d.ts` → emitted `.js` added to the existing `.gitignore` entry.
`src/` splits are ordinary TS modules.

`scripts/test-file-size.ts` enforces the 800-line cap against a shrinking allowlist. **Edit that
allowlist only to remove an entry or lower a count, never to admit a new file.**
