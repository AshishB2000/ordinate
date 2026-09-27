// SaaS response → rows — MAIN PROCESS, pure (no fs, no network).
//
// Every mapper here turns one API's records into positional rows plus columns,
// and says what each column IS when the API says so (`columnType`, which the
// dispatch keeps instead of re-detecting). The rule, from parse.ts's own
// number-accuracy promise: a number stays a number only when the API sends or
// documents a number. Ids — even all-digit ones — are text; ISO timestamps are
// dates; booleans are text ("true"/"false"; Ordinate has no boolean type);
// nested objects flatten to dotted keys; lists join with ", ".
//
// Three shapes of "the API says so":
//   • documented fields (GitHub, HubSpot): a fixed column list with types;
//   • typed properties (Notion): the property's own `type` decides;
//   • typed JSON values (Airtable, Stripe, the Sheets API): a column is a number
//     when every value arrived as a JSON number, a date when every value is a
//     date string, and text otherwise.

import { detectColumnType } from '../data/parse';
import type { ColumnType } from '../data/parse';
import type { ConnectorColumn } from './types';

export type Cell = string | number | boolean | null;
export type Rec = Record<string, Cell>;
export interface Table {
  columns: ConnectorColumn[];
  rows: Cell[][];
}
type Obj = Record<string, unknown>;

export function asObj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
export function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}
/** `get(o, 'user', 'login')` — a nested read that never throws. */
export function get(o: unknown, ...keys: string[]): unknown {
  let cur: unknown = o;
  for (const k of keys) cur = asObj(cur)[k];
  return cur;
}

/** The one readable string for a list element or a nested object. */
function display(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);
  const o = v as Obj;
  for (const k of ['name', 'filename', 'email', 'login', 'title', 'text', 'label', 'id']) {
    if (typeof o[k] === 'string' || typeof o[k] === 'number') return String(o[k]);
  }
  return JSON.stringify(v);
}

/** A list as one cell: its readable values, comma-joined; empty → null. */
export function joinList(list: unknown[]): Cell {
  const parts = list.map(display).filter((s) => s !== '');
  return parts.length ? parts.join(', ') : null;
}

/** Any JSON value as one cell. */
export function cell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return joinList(v);
  return display(v);
}

/** Nesting kept as columns (`a.b.c`); anything deeper becomes JSON text. */
const MAX_DEPTH = 2;

/**
 * Flatten an object to dotted keys. A Stripe list object (`{object:'list',
 * data:[…]}`) counts as its `data` array; arrays join; an empty object adds no
 * column at all.
 */
export function flatten(o: Obj, out: Rec = {}, prefix = '', depth = 0): Rec {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix + k;
    const list = asObj(v).object === 'list' && Array.isArray(asObj(v).data) ? (asObj(v).data as unknown[]) : null;
    if (list) out[key] = joinList(list);
    else if (Array.isArray(v)) out[key] = joinList(v);
    else if (v && typeof v === 'object') {
      if (depth < MAX_DEPTH) flatten(v as Obj, out, key + '.', depth + 1);
      else out[key] = JSON.stringify(v);
    } else out[key] = v === undefined ? null : (v as Cell);
  }
  return out;
}

export interface Declared {
  /** The source's own name for the type (shown in the schema tree). */
  type: string;
  columnType: ColumnType;
}
const T = (columnType: ColumnType, type: string = columnType): Declared => ({ type, columnType });

/** A column's type from the JSON values the API sent (see the header). */
export function inferType(values: Cell[]): Declared {
  const present = values.filter((v) => v !== null && v !== '');
  if (!present.length) return T('text', 'empty');
  if (present.every((v) => typeof v === 'number')) return T('number');
  if (present.every((v) => typeof v === 'boolean')) return T('text', 'boolean');
  if (present.every((v) => typeof v === 'string')) {
    // Only DATES are taken from the app's detector: a string that looks like a
    // number ("02134", "12345") was sent as a string, so it stays text.
    return detectColumnType(present as string[]) === 'date' ? T('date') : T('text', 'string');
  }
  return T('text', 'mixed');
}

/**
 * Records → a positional table. Columns in first-seen key order; a key a record
 * lacks is null there. `declared` types a column the API documents; every other
 * column is typed from its values. A declared column no record carried is still
 * a column, so an empty result keeps its schema.
 */
export function tabulate(records: Rec[], declared: Record<string, Declared> = {}): Table {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const r of records) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); names.push(k); }
  for (const k of Object.keys(declared)) if (!seen.has(k)) { seen.add(k); names.push(k); }
  const rows = records.map((r) => names.map((k) => (r[k] === undefined ? null : r[k])));
  const columns = names.map((name, i) => {
    const d = declared[name] || inferType(rows.map((row) => row[i]));
    return { name, type: d.type, columnType: d.columnType };
  });
  return { columns, rows };
}

// ── documented fields: GitHub, HubSpot ───────────────────────────────────────

type Spec = Array<[name: string, type: ColumnType, read: (o: Obj) => unknown]>;

function bySpec(items: unknown[], spec: Spec): Table {
  const declared: Record<string, Declared> = {};
  for (const [name, type] of spec) declared[name] = T(type);
  const records = items.map((it) => {
    const o = asObj(it);
    const r: Rec = {};
    for (const [name, , read] of spec) r[name] = cell(read(o));
    return r;
  });
  return tabulate(records, declared);
}

const logins = (v: unknown): Cell => joinList(asArray(v).map((u) => get(u, 'login')));
const names = (v: unknown): Cell => joinList(asArray(v).map((l) => get(l, 'name')));

// GitHub's numeric `id` is a 10+ digit identifier, so it is text; `number` is
// the issue number people sort and count by, so it is a number.
const GITHUB_ISSUE: Spec = [
  ['id', 'text', (o) => str(o.id)],
  ['number', 'number', (o) => o.number],
  ['title', 'text', (o) => o.title],
  ['state', 'text', (o) => o.state],
  ['state_reason', 'text', (o) => o.state_reason],
  ['author', 'text', (o) => get(o, 'user', 'login')],
  ['labels', 'text', (o) => names(o.labels)],
  ['assignees', 'text', (o) => logins(o.assignees)],
  ['milestone', 'text', (o) => get(o, 'milestone', 'title')],
  ['comments', 'number', (o) => o.comments],
  ['created_at', 'date', (o) => o.created_at],
  ['updated_at', 'date', (o) => o.updated_at],
  ['closed_at', 'date', (o) => o.closed_at],
  ['url', 'text', (o) => o.html_url],
];

const GITHUB_PULL: Spec = [
  ['id', 'text', (o) => str(o.id)],
  ['number', 'number', (o) => o.number],
  ['title', 'text', (o) => o.title],
  ['state', 'text', (o) => o.state],
  ['draft', 'text', (o) => o.draft],
  ['author', 'text', (o) => get(o, 'user', 'login')],
  ['labels', 'text', (o) => names(o.labels)],
  ['assignees', 'text', (o) => logins(o.assignees)],
  ['reviewers', 'text', (o) => logins(o.requested_reviewers)],
  ['base', 'text', (o) => get(o, 'base', 'ref')],
  ['head', 'text', (o) => get(o, 'head', 'ref')],
  ['created_at', 'date', (o) => o.created_at],
  ['updated_at', 'date', (o) => o.updated_at],
  ['closed_at', 'date', (o) => o.closed_at],
  ['merged_at', 'date', (o) => o.merged_at],
  ['url', 'text', (o) => o.html_url],
];

const GITHUB_COMMIT: Spec = [
  ['sha', 'text', (o) => o.sha],
  ['message', 'text', (o) => str(get(o, 'commit', 'message')).split('\n')[0]],
  ['author', 'text', (o) => get(o, 'author', 'login')],
  ['author_name', 'text', (o) => get(o, 'commit', 'author', 'name')],
  ['author_email', 'text', (o) => get(o, 'commit', 'author', 'email')],
  ['authored_at', 'date', (o) => get(o, 'commit', 'author', 'date')],
  ['committer_name', 'text', (o) => get(o, 'commit', 'committer', 'name')],
  ['committed_at', 'date', (o) => get(o, 'commit', 'committer', 'date')],
  ['url', 'text', (o) => o.html_url],
];

export const GITHUB_SPECS: Record<string, Spec> = { issues: GITHUB_ISSUE, pulls: GITHUB_PULL, commits: GITHUB_COMMIT };

export function githubRows(resource: string, items: unknown[]): Table {
  return bySpec(items, GITHUB_SPECS[resource] || GITHUB_ISSUE);
}

// HubSpot returns EVERY property as a string ("1500.00"), so its types cannot
// come from the values: they come from HubSpot's documented default properties,
// which are the ones requested.
export const HUBSPOT_PROPS: Record<string, Array<[string, ColumnType]>> = {
  contacts: [
    ['firstname', 'text'], ['lastname', 'text'], ['email', 'text'], ['phone', 'text'], ['company', 'text'],
    ['jobtitle', 'text'], ['lifecyclestage', 'text'], ['createdate', 'date'], ['lastmodifieddate', 'date'],
  ],
  deals: [
    ['dealname', 'text'], ['amount', 'number'], ['dealstage', 'text'], ['pipeline', 'text'],
    ['closedate', 'date'], ['createdate', 'date'], ['hs_lastmodifieddate', 'date'], ['hubspot_owner_id', 'text'],
  ],
  companies: [
    ['name', 'text'], ['domain', 'text'], ['industry', 'text'], ['city', 'text'], ['state', 'text'],
    ['country', 'text'], ['phone', 'text'], ['numberofemployees', 'number'], ['annualrevenue', 'number'],
    ['createdate', 'date'], ['hs_lastmodifieddate', 'date'],
  ],
};

export function hubspotRows(object: string, results: unknown[]): Table {
  const props = HUBSPOT_PROPS[object] || [];
  const spec: Spec = [['id', 'text', (o) => str(o.id)]];
  for (const [p, t] of props) spec.push([p, t, (o) => get(o, 'properties', p)]);
  return bySpec(results, spec);
}

// ── typed properties: Notion ─────────────────────────────────────────────────

const richText = (v: unknown): Cell => {
  const s = asArray(v).map((t) => str(get(t, 'plain_text'))).join('');
  return s || null;
};

/** One Notion property value → a cell, with the type its property declares. */
export function notionValue(prop: unknown): { value: Cell; type: string; columnType: ColumnType } {
  const p = asObj(prop);
  const type = str(p.type);
  const v = p[type];
  const out = (value: Cell, columnType: ColumnType, t = type) => ({ value, type: t, columnType });
  switch (type) {
    case 'title':
    case 'rich_text': return out(richText(v), 'text');
    case 'number': return out(typeof v === 'number' ? v : null, 'number');
    case 'select':
    case 'status': return out(str(get(v, 'name')) || null, 'text');
    case 'multi_select':
    case 'people':
    case 'files': return out(joinList(asArray(v)), 'text');
    case 'relation': return out(joinList(asArray(v).map((r) => get(r, 'id'))), 'text');
    case 'date': return out(str(get(v, 'start')) || null, 'date');
    case 'checkbox': return out(typeof v === 'boolean' ? v : null, 'text');
    case 'created_time':
    case 'last_edited_time': return out(str(v) || null, 'date');
    case 'created_by':
    case 'last_edited_by': return out(display(v) || null, 'text');
    case 'unique_id': {
      const n = get(v, 'number');
      const prefix = str(get(v, 'prefix'));
      return out(n === null || n === undefined ? null : prefix ? `${prefix}-${str(n)}` : str(n), 'text');
    }
    case 'formula': {
      // A formula's type is its RESULT's type, which Notion reports with it.
      const ft = str(get(v, 'type'));
      const inner = get(v, ft);
      if (ft === 'number') return out(typeof inner === 'number' ? inner : null, 'number');
      if (ft === 'date') return out(str(get(inner, 'start')) || null, 'date');
      return out(cell(inner), 'text');
    }
    case 'rollup': {
      const rt = str(get(v, 'type'));
      if (rt === 'number') return out(typeof get(v, 'number') === 'number' ? (get(v, 'number') as number) : null, 'number');
      if (rt === 'date') return out(str(get(v, 'date', 'start')) || null, 'date');
      return out(joinList(asArray(get(v, 'array')).map((x) => notionValue(x).value)), 'text');
    }
    default: return out(cell(v), 'text'); // url, email, phone_number, and anything newer
  }
}

export function notionRows(pages: unknown[]): Table {
  const declared: Record<string, Declared> = {
    page_id: T('text'), created_time: T('date'), last_edited_time: T('date'), page_url: T('text'),
  };
  const records = pages.map((pg) => {
    const o = asObj(pg);
    const r: Rec = {
      page_id: str(o.id) || null,
      created_time: str(o.created_time) || null,
      last_edited_time: str(o.last_edited_time) || null,
      page_url: str(o.url) || null,
    };
    for (const [name, prop] of Object.entries(asObj(o.properties))) {
      if (name in r) continue; // a property never shadows a page column
      const { value, type, columnType } = notionValue(prop);
      r[name] = value;
      if (!declared[name]) declared[name] = { type, columnType };
    }
    return r;
  });
  return tabulate(records, declared);
}

// ── typed JSON values: Airtable, Stripe, the Sheets API ──────────────────────

export function airtableRows(records: unknown[]): Table {
  return tabulate(records.map((rec) => {
    const o = asObj(rec);
    // Record id and created time first, under names a field is unlikely to have.
    const r: Rec = { record_id: str(o.id) || null, created_time: str(o.createdTime) || null };
    return flatten(asObj(o.fields), r);
  }), { record_id: T('text'), created_time: T('date') });
}

/**
 * Stripe timestamps are unix SECONDS (`created`, `canceled_at`,
 * `current_period_end`, `period.start`…). An integer under one of these names
 * becomes an ISO date — a column of 1.7e9s is not a number anyone means.
 */
const STRIPE_TIME = /(^|[._])(created|date|at|start|end|anchor)$/;

export function stripeRows(items: unknown[]): Table {
  return tabulate(items.map((it) => {
    const r = flatten(asObj(it));
    delete r.object; // "charge" on every row of the charges table
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'number' && Number.isInteger(v) && v > 0 && STRIPE_TIME.test(k)) {
        r[k] = new Date(v * 1000).toISOString();
      }
    }
    return r;
  }));
}

/** Sheets API `values` (first row = header), typed by the JSON values. */
export function sheetValuesRows(values: unknown[]): Table {
  const header = asArray(values[0]).map((h, i) => str(h).trim() || `col${i + 1}`);
  const records = values.slice(1).map((row) => {
    const cells = asArray(row);
    const r: Rec = {};
    header.forEach((h, i) => { r[h] = cell(cells[i]); }); // the API drops trailing empty cells
    return r;
  });
  return tabulate(records, records.length ? {} : Object.fromEntries(header.map((h) => [h, T('text')])));
}
