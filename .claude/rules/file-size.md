# File size

A source file over **500 lines** is a smell; over **800** it must be split before more is added to
it. One file = one job — if you cannot name a file's job in a short phrase without "and", it is two
files.

The check covers every `.ts`/`.tsx`/hand-written `.js` under `src/`, `scripts/` and `web/`; CSS Modules
are not counted, but the rule still applies to them. A split is an ordinary module: new file, import it.

`scripts/test-file-size.ts` enforces the 800-line cap against a shrinking allowlist. **Edit that
allowlist only to remove an entry or lower a count, never to admit a new file.**
