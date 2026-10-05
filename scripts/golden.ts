// GOLDEN FIXTURES — what a deleted reference implementation answered.
//
// Several suites were differential against the desktop app's copy of a rule
// (its classic-script UI, deleted at the T8.1 cutover). Before the copy went, its
// answers over each suite's own inputs were recorded into
// scripts/fixtures/golden/<name>.json, and the suite now compares the remaining
// implementation against those answers with the same strictness it had.
//
// The file is the RPC wire codec's tagged JSON (src/server/wire.ts), so NaN,
// -0, ±Infinity and undefined survive the round trip and Object.is still
// means what it meant against the live module.

import * as fs from 'fs';
import * as path from 'path';
import { decode } from '../src/server/wire';

const DIR = path.join(__dirname, 'fixtures', 'golden');

/** The recorded answers of one fixture file, decoded. */
export function golden<T = Record<string, unknown>>(name: string): T {
  return decode(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8')) as T;
}
