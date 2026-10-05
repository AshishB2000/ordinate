// ONE-OFF RECORDER (T8.1) for Icon.test.tsx: the desktop's hand-authored icon
// set (its icons.ts), read the way web/scripts/gen-icons.mjs read it, written to
// __golden__/icons.json. Runs only with GOLDEN_RECORD=1; deleted with the
// desktop tree in the next commit.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import { encode } from '../../../../src/server/wire.ts';

describe.runIf(process.env.GOLDEN_RECORD)('record icons', () => {
  it('writes __golden__/icons.json', () => {
    const hubIcons = readFileSync(path.resolve(process.cwd(), '..', 'renderer', 'hub', 'icons.ts'), 'utf8');
    const block = /^const ICONS[^{]*\{([\s\S]*?)^\};/m.exec(hubIcons)![1]!.replace(/\/\*[\s\S]*?\*\//g, '');
    const source = Object.fromEntries([...block.matchAll(/^\s*'?([\w-]+)'?:\s*'([^']*)',?\s*$/gm)].map((m) => [m[1], m[2]]));
    const out = path.join(process.cwd(), 'src/ui/icons/__golden__');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'icons.json'), encode(source) + '\n');
  });
});
