// The step vocabulary of the Prepare panel: the Add menu's list (legacy
// prepare.ts STEP_TYPES) and each stored step's one-line summary
// (stepSummaryText + pvMaskSummary + txStepSummary + powerStepSummary +
// reshape/clean/geo summaries). Display only — a summary reads the step's own
// fields; nothing here decides what a step does.

import { formatNumber } from '../../../../src/app/format.ts';
import type { Step } from './api';

export const STEP_TYPES: readonly { type: string; label: string }[] = [
  { type: 'calculated_field', label: 'Calculated field' },
  { type: 'filter', label: 'Filter rows' },
  { type: 'group_aggregate', label: 'Group & aggregate' },
  { type: 'dedupe', label: 'Remove duplicates' },
  { type: 'fill_empty', label: 'Fill empty cells' },
  { type: 'trim', label: 'Trim whitespace' },
  { type: 'drop_column', label: 'Drop column' },
  { type: 'rename_column', label: 'Rename column' },
  { type: 'mask_hash', label: 'Mask — hash' },
  { type: 'mask_redact', label: 'Mask — redact' },
  { type: 'mask_generalize', label: 'Mask — generalise' },
  { type: 'split_column', label: 'Split column' },
  { type: 'replace_values', label: 'Replace values' },
  { type: 'conditional_column', label: 'Conditional column' },
  { type: 'parse_date', label: 'Parse dates' },
  { type: 'dedupe_key', label: 'Keep one row per key' },
  { type: 'window', label: 'Window (rank, previous, running total)' },
  { type: 'unpivot', label: 'Unpivot columns to rows' },
  { type: 'pivot', label: 'Pivot rows to columns' },
  { type: 'lookup_join', label: 'Look up from another dataset' },
  { type: 'union', label: 'Append another dataset' },
  { type: 'text_terms', label: 'Text — count terms' },
  { type: 'text_sentiment', label: 'Text — sentiment score' },
  { type: 'keyword_rules', label: 'Text — tag with keyword rules' },
  { type: 'spatial_join', label: 'Assign regions (spatial join)' },
];

export const TEXT_STEPS = new Set(['text_terms', 'text_sentiment', 'keyword_rules']);

export const labelOf = (type: string): string => STEP_TYPES.find((s) => s.type === type)?.label ?? type;

export const AGG_FNS = ['sum', 'avg', 'count', 'min', 'max'] as const;

export const WINDOW_FNS: readonly { fn: string; label: string }[] = [
  { fn: 'row_number', label: 'Row number' },
  { fn: 'lag', label: 'Previous value (lag)' },
  { fn: 'lead', label: 'Next value (lead)' },
  { fn: 'running_sum', label: 'Running sum' },
  { fn: 'running_avg', label: 'Running average' },
];

/** The operators a filter step may carry from this form (src/data/filterOps.ts, less period / radius). */
export const FILTER_OPS: readonly { op: string; label: string }[] = [
  { op: '=', label: 'equals' },
  { op: '!=', label: 'does not equal' },
  { op: '>', label: 'greater than' },
  { op: '<', label: 'less than' },
  { op: '>=', label: 'at least' },
  { op: '<=', label: 'at most' },
  { op: 'contains', label: 'contains' },
  { op: 'is_empty', label: 'is empty' },
  { op: 'not_empty', label: 'is not empty' },
  { op: 'in', label: 'is one of' },
  { op: 'not in', label: 'is not one of' },
];
export const isListOp = (op: unknown): boolean => op === 'in' || op === 'not in';
export const isValuelessOp = (op: unknown): boolean => op === 'is_empty' || op === 'not_empty';

const str = (v: unknown): string => (v == null ? '' : String(v));
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : []);
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
const plural = (k: number, one: string, many: string): string => `${k} ${k === 1 ? one : many}`;

/** "1,250" — a count as the step list prints it. */
export const fmtN = (v: number): string => formatNumber(v, { maxDecimals: 0 });

const BOUNDARY: Record<string, string> = { us_state: 'US states', country: 'countries', us_county: 'US counties' };

/**
 * One line per step. `names` maps a dataset id to its name for the lookup and
 * append summaries (the project's dataset list).
 */
export function stepSummary(step: Step, names: ReadonlyMap<string, string> = new Map()): string {
  const s = step as Record<string, unknown>;
  const col = str(s.column);
  const other = (): string => {
    const name = names.get(str(s.datasetId));
    return name ? ` "${name}"` : ' another dataset';
  };
  switch (step.type) {
    case 'calculated_field':
      return `Calculated field "${str(s.name)}" = ${str(s.expression)}`;
    case 'filter': {
      if (s.op === 'period') return `Filter: ${col} in a period`;
      if (s.op === 'within_km') return `Filter: ${col} within a radius`;
      if (s.op === 'is_empty') return `Filter: ${col} is empty`;
      if (s.op === 'not_empty') return `Filter: ${col} is not empty`;
      if (isListOp(s.op)) {
        const vals = list(s.values).join(', ');
        return `Filter: ${col} ${str(s.op)} ${vals ? `(${vals})` : '— no values yet'}`;
      }
      return `Filter: ${col} ${str(s.op)} ${str(s.value)}`;
    }
    case 'group_aggregate': {
      const aggs = Array.isArray(s.aggregations)
        ? (s.aggregations as Record<string, unknown>[]).map((a) => `${str(a.fn)}(${str(a.column)}) → ${str(a.as)}`).join(', ')
        : '';
      return `Group by ${list(s.groupBy).join(', ')}; ${aggs}`;
    }
    case 'dedupe':
      return `Remove duplicates by ${list(s.columns).length ? list(s.columns).join(', ') : 'all columns'}`;
    case 'fill_empty':
      return `Fill empty in ${col} with "${str(s.value)}"`;
    case 'trim':
      return col ? `Trim whitespace in ${col}` : 'Trim whitespace (all text columns)';
    case 'drop_column':
      return `Drop column ${col}`;
    case 'rename_column':
      return `Rename ${str(s.from)} → ${str(s.to)}`;
    case 'mask_hash':
      return `Mask ${col}: hash to tokens`;
    case 'mask_redact': {
      const keep = Number.isFinite(n(s.keep)) ? n(s.keep) : 4;
      return keep > 0 ? `Mask ${col}: keep last ${keep}` : `Mask ${col}: hide all`;
    }
    case 'mask_generalize':
      if (s.mode === 'month') return `Mask ${col}: month only`;
      if (s.mode === 'domain') return `Mask ${col}: domain only`;
      return `Mask ${col}: buckets of ${n(s.size) > 0 ? formatNumber(n(s.size)) : 10}`;
    case 'split_column': {
      const by = s.mode === 'position' ? `at positions ${list(s.positions).join(', ')}` : s.mode === 'regex' ? `on /${str(s.pattern)}/` : `on "${str(s.delimiter)}"`;
      const into = s.into === 'rows' ? 'rows' : `${n(s.count) || list(s.positions).length + 1} columns`;
      return `Split ${col} ${by} into ${into}`;
    }
    case 'unpivot':
      return `Unpivot ${list(s.columns).join(', ')} → ${str(s.attribute) || 'attribute'}, ${str(s.value) || 'value'}`;
    case 'pivot': {
      const per = list(s.groupBy).length ? ` per ${list(s.groupBy).join(', ')}` : '';
      return `Pivot ${str(s.key)} into columns: ${str(s.fn)}(${str(s.value)})${per}`;
    }
    case 'window': {
      const w = WINDOW_FNS.find((x) => x.fn === s.fn);
      const of = col ? ` of ${col}` : '';
      const by = s.orderBy ? ` by ${str(s.orderBy)}${s.desc ? ' (desc)' : ''}` : '';
      const per = list(s.partitionBy).length ? ` per ${list(s.partitionBy).join(', ')}` : '';
      return `${w ? w.label : str(s.fn)}${of}${by}${per} → ${str(s.as)}`;
    }
    case 'parse_date':
      return `Parse ${col} as ${str(s.format)}${s.as ? ` → ${str(s.as)}` : ''}`;
    case 'dedupe_key': {
      const keep = s.keep === 'max' || s.keep === 'min' ? `the ${str(s.keep)} ${str(s.by)}` : `the ${str(s.keep)}`;
      return `One row per ${list(s.columns).join(', ')}, keeping ${keep}`;
    }
    case 'replace_values':
      return `Replace in ${col} (${str(s.mode)}): ${plural(list(s.rules).length, 'rule', 'rules')}`;
    case 'conditional_column':
      return `Conditional column "${str(s.name)}": ${plural(list(s.rules).length, 'rule', 'rules')}`;
    case 'lookup_join':
      return `Look up ${list(s.columns).join(', ')} by ${str(s.leftKey)} = ${str(s.rightKey)}${other()}`;
    case 'union':
      return `Append the rows of${other()}`;
    case 'text_sentiment':
      return `Sentiment of ${col} → ${str(s.as) || `${col}_sentiment`}${s.lexiconVersion ? ` (${str(s.lexiconVersion)})` : ''}`;
    case 'keyword_rules':
      return `Tag ${col} with ${plural(list(s.rules).length, 'rule', 'rules')} → ${str(s.as) || `${col}_category`}`;
    case 'text_terms': {
      const minN = n(s.minN) || 1;
      const maxN = n(s.maxN) || 1;
      const range = minN === maxN ? (minN === 1 ? 'words' : `${minN}-word terms`) : `${minN}–${maxN}-word terms`;
      const per = s.by ? `${s.rank === 'tfidf' ? ', most distinctive per ' : ', per '}${str(s.by)}` : '';
      return `Top ${str(s.top)} ${range} in ${col}${per}`;
    }
    case 'spatial_join':
      return `Assign ${str(s.as) || 'region'} from ${str(s.lat)}, ${str(s.lng)} by ${BOUNDARY[str(s.boundary)] ?? 'your boundaries'}`;
    case 'segment':
      // Fitted by the Segments workbench (T2.10); its own editor renames the column only.
      return `Segments: ${plural(list(s.names).length, 'group', 'groups')} by ${list(s.features).join(', ')} → ${col}`;
    default:
      return 'Unknown step';
  }
}
