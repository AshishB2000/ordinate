// A step editor's state and its Save check — the legacy forms' "getter"
// (prepareForms / prepareReshape / prepareClean / prepareCombine / prepareMask /
// prepareGeo / textSteps buildStepForm), as two pure functions: the draft a form
// edits, and the step (or the reason there is none) Save would send. The
// server re-validates every step (src/data/stepsSanitize.ts and friends); this
// only stops an obviously unfinished form, with the desktop's own messages.

import { detectLatLon } from '../../charts/maps/geoCluster';
import type { Column, Step } from './api';
import { isListOp, isValuelessOp } from './steps';

export type Draft = Record<string, unknown>;
export type Built = { steps: Step[] } | { error: string };

const str = (v: unknown): string => (v == null ? '' : String(v));
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const fail = (error: string): Built => ({ error });
const one = (step: Step): Built => ({ steps: [step] });

/** The allow-list the server accepts (src/data/stepsClean.ts DATE_FORMATS × TIME_FORMATS). */
const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MMM-YYYY', 'DD.MM.YYYY', 'YYYY/MM/DD', 'YYYYMMDD'];
const TIME_FORMATS = ['', ' HH:mm', ' HH:mm:ss', 'THH:mm', 'THH:mm:ss'];
export const PARSE_FORMATS = DATE_FORMATS.flatMap((d) => TIME_FORMATS.map((t) => d + t));

/**
 * The draft a NEW step of `type` starts from — or the stored step being edited.
 * `prefill` carries a column (and, for keyword rules, the profile's top terms)
 * from whatever opened the editor.
 */
export function initialDraft(type: string, existing: Step | null, columns: readonly Column[], prefill: Draft = {}): Draft {
  if (existing) {
    const d: Draft = { ...existing };
    if (type === 'filter') {
      d.valuesText = arr(existing.values).map(str).join(', ');
      d.value = str(existing.value);
    }
    if (type === 'split_column') d.positionsText = arr(existing.positions).join(', ');
    if (type === 'text_terms') d.range = `${str(existing.minN) || 1}-${str(existing.maxN) || 1}`;
    if (type === 'keyword_rules') d.otherwise = existing.otherwise === null || existing.otherwise === undefined ? '' : str(existing.otherwise);
    if (type === 'conditional_column') d.else = existing.else == null ? '' : str(existing.else);
    return d;
  }
  const first = (pred: (c: Column) => boolean = () => true): string => columns.find(pred)?.name ?? '';
  const column = str(prefill.column) || '';
  const text = column || first((c) => c.type === 'text');
  switch (type) {
    case 'filter':
      return { type, column: column || first(), op: '=', value: '', valuesText: '' };
    case 'group_aggregate':
      return { type, groupBy: [], aggregations: [{ fn: 'sum', column: '', as: '' }] };
    case 'dedupe':
      return { type, columns: [] };
    case 'trim':
      return { type, column };
    case 'mask_redact':
      return { type, column, keep: 4 };
    case 'mask_generalize':
      return { type, column, mode: 'bucket', size: 10 };
    case 'split_column':
      return { type, column, mode: 'delimiter', delimiter: ',', positionsText: '', pattern: '', into: 'columns', count: 2 };
    case 'unpivot':
      return { type, columns: [], attribute: 'attribute', value: 'value' };
    case 'pivot':
      return { type, key: '', value: '', fn: 'sum', groupBy: [] };
    case 'window':
      return { type, fn: 'row_number', column: '', offset: 1, partitionBy: [], orderBy: '', desc: false, as: '' };
    case 'parse_date':
      return { type, column, format: 'YYYY-MM-DD', as: '' };
    case 'dedupe_key':
      return { type, columns: [], keep: 'first', by: '' };
    case 'replace_values':
      return { type, column, mode: 'exact', rules: [{ from: '', to: '' }] };
    case 'conditional_column':
      return { type, name: '', rules: [{ when: { column: first(), op: '=', value: '' }, then: '' }], else: '' };
    case 'lookup_join':
      return { type, datasetId: '', leftKey: '', rightKey: '', columns: [], prefix: '' };
    case 'union':
      return { type, datasetId: '', mapping: [] };
    case 'text_terms':
      return { type, column: text, lang: str(prefill.lang) || 'en', range: prefill.minN ? `${str(prefill.minN)}-${str(prefill.maxN)}` : '1-1', by: '', rank: 'tfidf', top: Number(prefill.top) || 25 };
    case 'text_sentiment':
      return { type, column: text, as: '' };
    case 'keyword_rules':
      return { type, column: text, as: '', rules: [{ pattern: '', match: 'word', category: '' }], otherwise: 'Other', terms: arr(prefill.terms).slice(0, 8) };
    case 'spatial_join': {
      // The coordinate columns by name (the maps' own detector), when they are numbers.
      const found = detectLatLon(columns.filter((c) => c.type === 'number'));
      return { type, lat: found?.lat ?? '', lng: found?.lon ?? '', boundary: 'us_state', boundaryId: '', property: '', as: 'region', unmatched: '' };
    }
    default:
      return { type, column };
  }
}

/** A filter operand as the column's type stores it: a number column compares numbers. */
function operand(raw: string, colType: string | undefined): string | number {
  const t = raw.trim();
  return colType === 'number' && t !== '' && Number.isFinite(Number(t)) ? Number(t) : raw;
}

/** The step Save would send, or why it cannot yet. */
export function buildStep(type: string, d: Draft, columns: readonly Column[]): Built {
  const col = str(d.column);
  const typeOf = (name: string) => columns.find((c) => c.name === name)?.type;
  switch (type) {
    case 'filter': {
      if (!col) return fail('Pick a column to filter on.');
      const op = str(d.op);
      if (!op) return fail('Set a condition for this filter.');
      if (isValuelessOp(op)) return one({ type, column: col, op });
      if (isListOp(op)) {
        const values = str(d.valuesText).split(',').map((v) => v.trim()).filter(Boolean).map((v) => operand(v, typeOf(col)));
        if (!values.length) return fail('Set a condition for this filter.');
        return one({ type, column: col, op, values });
      }
      return one({ type, column: col, op, value: operand(str(d.value), typeOf(col)) });
    }
    case 'group_aggregate': {
      const groupBy = arr<string>(d.groupBy);
      if (!groupBy.length) return fail('Pick at least one column to group by.');
      const aggregations = arr<Draft>(d.aggregations)
        .filter((a) => str(a.column) && str(a.fn))
        .map((a) => ({ column: str(a.column), fn: str(a.fn), as: str(a.as).trim() || `${str(a.fn)}_${str(a.column)}` }));
      if (!aggregations.length) return fail('Add at least one aggregation.');
      return one({ type, groupBy, aggregations });
    }
    case 'dedupe': {
      const cols = arr<string>(d.columns);
      return one(cols.length ? { type, columns: cols } : { type });
    }
    case 'fill_empty':
      return col ? one({ type, column: col, value: str(d.value) }) : fail('Pick a column.');
    case 'trim':
      return one(col ? { type, column: col } : { type });
    case 'drop_column':
      return col ? one({ type, column: col }) : fail('Pick a column.');
    case 'rename_column': {
      const from = str(d.from);
      const to = str(d.to).trim();
      return from && to ? one({ type, from, to }) : fail('Pick a column and enter a new name.');
    }
    case 'mask_hash':
      return col ? one({ type, column: col }) : fail('Pick a column to mask.');
    case 'mask_redact':
      return col ? one({ type, column: col, keep: Math.max(0, Math.min(8, Math.floor(Number(d.keep) || 0))) }) : fail('Pick a column to mask.');
    case 'mask_generalize': {
      if (!col) return fail('Pick a column to mask.');
      if (d.mode !== 'bucket') return one({ type, column: col, mode: str(d.mode) });
      const size = Number(d.size);
      return size > 0 ? one({ type, column: col, mode: 'bucket', size }) : fail('Enter a bucket size greater than zero.');
    }
    case 'split_column': {
      if (!col) return fail('Pick a column to split.');
      const mode = str(d.mode) || 'delimiter';
      const into = str(d.into) || 'columns';
      const step: Step = { type, column: col, mode, into };
      if (mode === 'delimiter') {
        if (!str(d.delimiter)) return fail('Enter the delimiter.');
        step.delimiter = str(d.delimiter);
      } else if (mode === 'position') {
        step.positions = str(d.positionsText).split(/[\s,]+/).filter(Boolean).map(Number);
      } else {
        step.pattern = str(d.pattern);
        if (d.ignoreCase) step.ignoreCase = true;
      }
      if (into === 'columns' && mode !== 'position') step.count = Number(d.count) || 2;
      return one(step);
    }
    case 'unpivot': {
      const cols = arr<string>(d.columns);
      if (!cols.length) return fail('Pick at least one column to unpivot.');
      return one({ type, columns: cols, attribute: str(d.attribute).trim() || 'attribute', value: str(d.value).trim() || 'value' });
    }
    case 'pivot': {
      const key = str(d.key);
      const value = str(d.value);
      const groupBy = arr<string>(d.groupBy);
      if (!key || !value) return fail('Pick a key column and a value column.');
      if (key === value || groupBy.includes(key) || groupBy.includes(value)) return fail('The key, the value and the "one row per" columns must all be different.');
      return one({ type, key, value, fn: str(d.fn) || 'sum', groupBy });
    }
    case 'window': {
      const as = str(d.as).trim();
      if (!as) return fail('Name the new column.');
      const fn = str(d.fn) || 'row_number';
      const step: Step = { type, fn, as };
      if (fn !== 'row_number') {
        if (!col) return fail('Pick the value column.');
        step.column = col;
      }
      if (fn === 'lag' || fn === 'lead') step.offset = Math.max(1, Math.floor(Number(d.offset) || 1));
      if (arr(d.partitionBy).length) step.partitionBy = arr(d.partitionBy);
      if (str(d.orderBy)) step.orderBy = str(d.orderBy);
      if (d.desc) step.desc = true;
      return one(step);
    }
    case 'parse_date': {
      if (!col) return fail('Pick the column to parse.');
      const step: Step = { type, column: col, format: str(d.format) || 'YYYY-MM-DD' };
      if (str(d.as).trim()) step.as = str(d.as).trim();
      return one(step);
    }
    case 'dedupe_key': {
      const cols = arr<string>(d.columns);
      if (!cols.length) return fail('Pick at least one key column.');
      const keep = str(d.keep) || 'first';
      const step: Step = { type, columns: cols, keep };
      if (keep === 'max' || keep === 'min') {
        if (!str(d.by)) return fail('Pick the column to rank by.');
        step.by = str(d.by);
      }
      return one(step);
    }
    case 'replace_values': {
      if (!col) return fail('Pick a column.');
      const mode = str(d.mode) || 'exact';
      const rules = arr<Draft>(d.rules).map((r) => ({ from: str(r.from), to: str(r.to) })).filter((r) => mode === 'exact' || r.from !== '');
      if (!rules.length) return fail('Add at least one rule with text to find.');
      const step: Step = { type, column: col, mode, rules };
      if (mode === 'regex' && d.ignoreCase) step.ignoreCase = true;
      return one(step);
    }
    case 'conditional_column': {
      const name = str(d.name).trim();
      if (!name) return fail('Name the new column.');
      const rules = arr<{ when: Draft; then: unknown }>(d.rules)
        .filter((r) => str(r.when?.column))
        .map((r) => {
          const op = str(r.when.op) || '=';
          const when: Draft = { column: str(r.when.column), op };
          if (!isValuelessOp(op)) when.value = str(r.when.value);
          return { when, then: str(r.then) };
        });
      if (!rules.length) return fail('Add at least one rule.');
      return one({ type, name, rules, else: str(d.else) === '' ? null : str(d.else) });
    }
    case 'lookup_join': {
      const step: Step = { type, datasetId: str(d.datasetId), leftKey: str(d.leftKey), rightKey: str(d.rightKey), columns: arr(d.columns) };
      if (!step.datasetId || !step.leftKey || !step.rightKey) return fail('Pick the other dataset and a key on each side.');
      if (!arr(step.columns).length) return fail('Pick at least one column to bring across.');
      if (str(d.prefix)) step.prefix = str(d.prefix);
      return one(step);
    }
    case 'union': {
      if (!str(d.datasetId)) return fail('Pick the dataset to append.');
      const mapping = arr<Draft>(d.mapping).filter((m) => str(m.from)).map((m) => ({ from: str(m.from), to: str(m.to) }));
      return one(mapping.length ? { type, datasetId: str(d.datasetId), mapping } : { type, datasetId: str(d.datasetId) });
    }
    case 'text_terms': {
      if (!col) return fail('Pick the text column.');
      const [minN, maxN] = str(d.range || '1-1').split('-').map(Number);
      const step: Step = { type, column: col, lang: str(d.lang) || 'en', minN, maxN, top: Math.max(1, Math.min(1000, Math.floor(Number(d.top) || 25))), rank: 'count' };
      if (str(d.by) && str(d.by) !== col) {
        step.by = str(d.by);
        step.rank = str(d.rank) || 'tfidf';
      }
      if (d.keepNumbers) step.keepNumbers = true;
      if (d.sentiment) step.sentiment = true;
      return one(step);
    }
    case 'text_sentiment': {
      if (!col) return fail('Pick the text column.');
      const step: Step = { type, column: col };
      if (d.lexiconVersion) step.lexiconVersion = d.lexiconVersion;
      if (str(d.as).trim()) step.as = str(d.as).trim();
      return one(step);
    }
    case 'keyword_rules': {
      if (!col) return fail('Pick the text column.');
      const rules = arr<Draft>(d.rules)
        .filter((r) => str(r.pattern).trim())
        .map((r) => ({ pattern: str(r.pattern), match: str(r.match) || 'word', category: str(r.category).trim(), ...(r.caseSensitive ? { caseSensitive: true } : {}) }));
      if (!rules.length) return fail('Add at least one rule with a pattern.');
      if (rules.some((r) => !r.category)) return fail('Give every rule a category.');
      const step: Step = { type, column: col, rules, otherwise: str(d.otherwise) === '' ? null : str(d.otherwise) };
      if (str(d.as).trim()) step.as = str(d.as).trim();
      return one(step);
    }
    case 'spatial_join': {
      const step: Step = { type, lat: str(d.lat), lng: str(d.lng), boundary: str(d.boundary) || 'us_state', as: str(d.as).trim() || 'region', unmatched: str(d.unmatched) };
      if (!step.lat || !step.lng) return fail('Pick the latitude and longitude columns.');
      if (step.lat === step.lng) return fail('Latitude and longitude must be two different columns.');
      if (step.boundary === 'custom') {
        if (!str(d.boundaryId) || !str(d.property)) return fail('Pick the boundary set and the property that names each region.');
        step.boundaryId = str(d.boundaryId);
        step.property = str(d.property);
      }
      return one(step);
    }
    case 'segment':
      return str(d.column).trim() ? one({ ...(d as Step), column: str(d.column).trim() }) : fail('Name the new column.');
    default:
      return fail('This step cannot be edited here.');
  }
}
