// Which steps of a filter list the web carries without reading (a glossary term, a step a newer
// release added) — the web's mirror of the server's rule (src/data/filterList.ts isKeptStep plus
// its type-name test), pinned to it by keptStep.test.ts. PURE and import-free apart from a type, so
// explore/spec.ts (which the e2e loads type-stripped in Node) can use it. The server is the gate: it
// re-sanitizes every list it is sent, including the size limit this does not repeat.

import type { KeptStep } from './encoding';

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** src/data/transforms.ts STEP_TYPES: Prepare steps, none of which belongs in a filter list ('filter' is the one that does). */
export const PREPARE_STEP_TYPES: ReadonlySet<string> = new Set([
  'calculated_field', 'filter', 'group_aggregate', 'dedupe', 'fill_empty', 'trim', 'drop_column', 'rename_column',
  'mask_hash', 'mask_redact', 'mask_generalize', 'split_column', 'unpivot', 'pivot', 'parse_date', 'dedupe_key',
  'replace_values', 'conditional_column', 'union', 'lookup_join', 'window', 'spatial_join', 'segment',
  'text_terms', 'text_sentiment', 'keyword_rules',
]);

/**
 * An object whose `type` is a step name that is no `filter` and no Prepare step. Not a type guard on
 * purpose: a screen's filter list is typed `FilterStep[]` (the server's own shortcut), and a guard
 * would narrow every step left after the check to `never`.
 */
export function isKeptStep(s: unknown): boolean {
  const type = s && typeof s === 'object' ? (s as { type?: unknown }).type : undefined;
  return typeof type === 'string' && NAME.test(type) && !PREPARE_STEP_TYPES.has(type);
}

const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
      : (JSON.stringify(v) ?? 'null');

/** A kept step's identity for a dedupe: its whole body (key order aside), under a prefix no filter's key shares. */
export const keptKey = (s: KeptStep): string => 'kept:' + stable(s);
