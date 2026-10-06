// GOLDEN FIXTURES — what the desktop app's code answered, recorded once.
//
// The chart, grid, map and Markdown ports were differential against the
// desktop's classic scripts. Those went at the T8.1 cutover; before they did,
// their answers over each test's own inputs were recorded into a `__golden__/`
// folder beside the test, and the test now compares the port against them with
// the same strictness. The files are the RPC wire codec's tagged JSON, so NaN,
// -0, ±Infinity and undefined (as a value or an object key) survive.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decode } from '../../src/server/wire.ts';

/** One fixture file, decoded. `file` is relative to web/ (Vitest's cwd). */
export function golden<T = Record<string, unknown>>(file: string): T {
  return decode(readFileSync(path.resolve(process.cwd(), file), 'utf8')) as T;
}

/**
 * A fixture (or one `field` of it) recorded as ordered snapshots per test name: `next(name)` hands
 * them back in the order they were taken, and `rest()` names any a test left
 * uncompared — a comparison that silently stopped running fails loudly.
 */
export function goldenSequence(file: string, field?: string) {
  const whole = golden<Record<string, unknown>>(file);
  const all = (field ? whole[field] : whole) as Record<string, unknown[]>;
  const used = new Map<string, number>();
  return {
    next(name: string): unknown {
      const i = used.get(name) ?? 0;
      const list = all[name];
      if (!list || i >= list.length) throw new Error(`golden ${file}: no snapshot #${i} for "${name}"`);
      used.set(name, i + 1);
      return list[i];
    },
    /** Snapshots recorded for a name this run touched but did not compare. */
    rest(): string[] {
      return [...used].filter(([name, n]) => n !== all[name]!.length).map(([name, n]) => `${name}: ${n}/${all[name]!.length}`);
    },
  };
}
