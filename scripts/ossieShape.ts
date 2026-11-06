// A test-only structural check of an Ossie document against the required keys, types and enums of spec.md at
// 0.2.0.dev0 (docs/semantic-layer/ossie-mapping.md). Not a JSON Schema validator (that would be a dependency). Returns
// the problems; none means the emitted parts satisfy the spec.

const TYPES = ['String', 'Integer', 'Decimal', 'Float', 'Boolean', 'Date', 'Time', 'DateTime', 'DateTimeTz', 'Opaque'];
type O = Record<string, unknown>;
const isO = (v: unknown): v is O => !!v && typeof v === 'object' && !Array.isArray(v);

export function ossieShape(text: string): string[] {
  const bad: string[] = [];
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return ['not JSON']; }
  if (!isO(doc)) return ['root is not an object'];
  const need = (o: O, key: string, type: 'string' | 'array', at: string): void => {
    const v = o[key];
    if (type === 'array' ? !Array.isArray(v) : typeof v !== 'string') bad.push(`${at}.${key} must be ${type === 'array' ? 'an array' : 'a string'}`);
  };
  const optional = (o: O, key: string, type: 'string' | 'array', at: string): void => { if (o[key] !== undefined) need(o, key, type, at); };
  const expr = (o: O, at: string): void => {
    if (!isO(o.expression)) return void bad.push(`${at}.expression must be an object`);
    if (typeof o.expression.sql !== 'string' && !Array.isArray(o.expression.dialects)) bad.push(`${at}.expression needs sql or dialects`);
  };
  need(doc, 'version', 'string', 'root');
  need(doc, 'name', 'string', 'root');
  need(doc, 'datasets', 'array', 'root');
  if (Array.isArray(doc.datasets) && doc.datasets.length === 0) bad.push('root.datasets must not be empty');
  for (const d of (Array.isArray(doc.datasets) ? doc.datasets : []) as O[]) {
    const at = `datasets[${String(d.name)}]`;
    need(d, 'name', 'string', at); need(d, 'source', 'string', at);
    optional(d, 'primary_key', 'array', at); optional(d, 'fields', 'array', at); optional(d, 'metrics', 'array', at);
    for (const f of (Array.isArray(d.fields) ? d.fields : []) as O[]) {
      need(f, 'name', 'string', `${at}.fields`); expr(f, `${at}.fields[${String(f.name)}]`);
      if (f.datatype !== undefined && !TYPES.includes(f.datatype as string)) bad.push(`${at}.fields[${String(f.name)}].datatype is not in the enum`);
      if (f.dimension !== undefined && (!isO(f.dimension) || typeof f.dimension.is_time !== 'boolean')) bad.push(`${at}.fields[${String(f.name)}].dimension.is_time must be a boolean`);
    }
    for (const m of (Array.isArray(d.metrics) ? d.metrics : []) as O[]) { need(m, 'name', 'string', `${at}.metrics`); expr(m, `${at}.metrics[${String(m.name)}]`); }
  }
  for (const r of (Array.isArray(doc.relationships) ? doc.relationships : []) as O[]) {
    const at = `relationships[${String(r.name)}]`;
    for (const k of ['name', 'from', 'to']) need(r, k, 'string', at);
    for (const k of ['from_columns', 'to_columns']) need(r, k, 'array', at);
    if (Array.isArray(r.from_columns) && Array.isArray(r.to_columns) && r.from_columns.length !== r.to_columns.length) bad.push(`${at} columns differ in length`);
  }
  for (const e of (Array.isArray(doc.custom_extensions) ? doc.custom_extensions : []) as O[]) {
    need(e, 'vendor_name', 'string', 'custom_extensions'); need(e, 'data', 'string', 'custom_extensions');
    try { JSON.parse(String(e.data)); } catch { bad.push('custom_extensions.data is not JSON'); }
  }
  return bad;
}
