// Deep research (docs/deep-research/00-design.md): the ONE action line a research step may return — PURE.
//
// A step call answers with exactly one JSON object on one line: an `answer` (a chart spec), an `sql` (datasets by name),
// a `drivers` request, or `done`. Anything else is refused, never repaired: prose, two actions, broken JSON, a kind not
// listed, or a number where a NAME goes (a dataset, a column). `answer` and `sql` pass the dock's own whitelist
// (./suggestedAction `validateAction`); every NAME in them is resolved later against the real columns by the same gates
// an ask uses. The reply is data, never instructions, and it carries no figure the app would trust.

import { validateAction, ACTION_MARKER } from './suggestedAction';

export type ResearchAction =
  | { kind: 'answer'; intent: string; spec: Record<string, unknown> }
  | { kind: 'sql'; intent: string; datasets: string[] }
  | { kind: 'drivers'; request: Record<string, unknown> }
  | { kind: 'done' };

export type ParseCode = 'empty' | 'prose' | 'many' | 'json' | 'kind' | 'shape' | 'figure_name';
export type Parsed = { ok: true; action: ResearchAction } | { ok: false; code: ParseCode };

/** Keys whose value names a dataset or a column: a number there is a figure where a name goes. */
const NAME_KEYS = new Set(['dataset', 'datasetId', 'category', 'series', 'column', 'dimension', 'categoryDataset', 'seriesDataset']);
const NUMBERISH = /^\s*[-+]?\d[\d,]*(\.\d+)?\s*%?\s*$/;
const MAX_REQUEST_CHARS = 4000;

function figureName(v: unknown, depth = 0): boolean {
  if (depth > 6 || !v || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some((x) => figureName(x, depth + 1));
  for (const [k, x] of Object.entries(v)) {
    const bad = (n: unknown): boolean => typeof n === 'number' || (typeof n === 'string' && NUMBERISH.test(n));
    if (NAME_KEYS.has(k) && bad(x)) return true;
    if (k === 'datasets' && Array.isArray(x) && x.some(bad)) return true;
    if (figureName(x, depth + 1)) return true;
  }
  return false;
}

const lineOf = (raw: string): string => {
  let s = raw.trim();
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(s);
  if (fenced) s = fenced[1].trim();
  return s.startsWith(ACTION_MARKER) ? s.slice(ACTION_MARKER.length).trim() : s;
};

export function parseActionLine(raw: string | null | undefined): Parsed {
  const text = lineOf(String(raw ?? ''));
  if (!text) return { ok: false, code: 'empty' };
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) return { ok: false, code: lines.filter((l) => l.startsWith('{') || l.startsWith(ACTION_MARKER)).length > 1 ? 'many' : 'prose' };
  const one = lines[0].startsWith(ACTION_MARKER) ? lines[0].slice(ACTION_MARKER.length).trim() : lines[0];
  if (!one.startsWith('{') || !one.endsWith('}')) return { ok: false, code: 'prose' };
  let obj: unknown;
  try {
    obj = JSON.parse(one);
  } catch {
    return { ok: false, code: /\}\s*\{/.test(one) ? 'many' : 'json' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, code: 'json' };
  const o = obj as Record<string, unknown>;
  if (figureName(o)) return { ok: false, code: 'figure_name' };
  if (o.kind === 'done') return { ok: true, action: { kind: 'done' } };
  if (o.kind === 'drivers') {
    const request = o.request;
    if (!request || typeof request !== 'object' || Array.isArray(request)) return { ok: false, code: 'shape' };
    let size = Infinity;
    try { size = JSON.stringify(request).length; } catch { /* unserialisable */ }
    return size <= MAX_REQUEST_CHARS ? { ok: true, action: { kind: 'drivers', request: request as Record<string, unknown> } } : { ok: false, code: 'shape' };
  }
  if (o.kind !== 'answer' && o.kind !== 'sql') return { ok: false, code: 'kind' };
  const a = validateAction(o); // the dock's whitelist: a spec worth its spec, an sql worth its datasets
  if (a.kind === 'answer' && a.spec) return { ok: true, action: { kind: 'answer', intent: a.intent, spec: a.spec } };
  if (a.kind === 'sql' && a.datasets) return { ok: true, action: { kind: 'sql', intent: a.intent, datasets: a.datasets } };
  return { ok: false, code: 'shape' };
}
