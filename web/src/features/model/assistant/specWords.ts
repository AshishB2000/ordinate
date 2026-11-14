// A stored answer spec in words, for "how it was answered": dataset · measures by category · split · filters · top.
// Words only, never a figure; it reads names and settings and does no arithmetic. Total: a spec it cannot read
// still gives the dataset's name.

const AGG: Record<string, string> = { sum: 'sum of', avg: 'average of', count: 'count of', min: 'min of', max: 'max of', none: '' };
const OP: Record<string, string> = { is_empty: 'is empty', not_empty: 'is not empty', contains: 'contains', 'not in': 'not in' };
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

function measure(m: unknown): string {
  const o = obj(m);
  const col = str(o?.column);
  return col ? `${AGG[str(o?.aggregation)] ?? ''} ${col}`.trim() : '';
}

function filter(f: unknown, terms: Record<string, string>): string {
  const o = obj(f);
  if (!o) return '';
  if (typeof o.term === 'string') return terms[o.term] || 'a glossary term';
  const col = str(o.column);
  if (!col) return '';
  if (typeof o.period === 'string') {
    const back = typeof o.yearsBack === 'number' ? `, ${o.yearsBack} years back` : '';
    const n = typeof o.n === 'number' ? `_${o.n}_` : '_n_'; // "last_n_days" with n 30 reads "last 30 days"
    return `${col} ${o.period.replace('_n_', n).replace(/_/g, ' ')}${back}`;
  }
  const op = str(o.op);
  const values = Array.isArray(o.values) ? o.values.map(str).join(', ') : str(o.value);
  return [col, OP[op] ?? op, values].filter(Boolean).join(' ');
}

export function specWords(spec: unknown, datasetName: string, termNames: Record<string, string> = {}): string {
  const o = obj(spec) ?? {};
  const measures = (Array.isArray(o.measures) ? o.measures : []).map(measure).filter(Boolean).join(', ');
  const by = str(o.category);
  const parts = [
    datasetName,
    [measures, by && `by ${by}`].filter(Boolean).join(' '),
    str(o.series) && `split by ${str(o.series)}`,
    ...(Array.isArray(o.filters) ? o.filters : []).map((f) => filter(f, termNames)),
    typeof o.top === 'number' && `top ${o.top}`,
  ];
  return parts.filter(Boolean).join(' · ');
}
