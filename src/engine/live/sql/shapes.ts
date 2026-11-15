// The allow-list of SQL on Live datasets, as DATA (docs/live-data/01-live-sql.md F-D2) — PURE.
//
// Three tables, every one closed:
//
//   SHAPES      every node shape of DuckDB's parse tree (`json_serialize_sql`) the translator reads,
//               and every key such a node may carry: `read` (./tree.ts reads it), `any` (position
//               only) or the one default it must hold, with the SQL construct a different value is.
//               A key not listed, or a listed default with another value, is refused — so a DuckDB
//               upgrade that adds a key (a SETTINGS clause, a new time-travel form) fails closed,
//               and scripts/test-liveSqlCompile.ts's census names the key.
//   REFUSED     node shapes that are constructs F1 refuses, by name (a lambda, WITH RECURSIVE…).
//   FUNCTIONS   function names → the IR they become. Nothing else is callable: the IR has no
//               generic function node, so a name off this list has nothing to be printed as.
//
// Mutable only so a test can widen one entry and show its guard was the one refusing (a NEGATIVE
// CONTROL); nothing in src/ writes them.

/** `read`: read, and walked by the census; `any`: read as a plain value (a position, a constant's payload), not walked. */
export type KeyRule = 'read' | 'any' | { def: unknown; as: string };

const AT = { def: null, as: 'AT (…)' };
const SAMPLE = { def: null, as: 'USING SAMPLE' };
const NONE = (as: string): KeyRule => ({ def: [], as });
const EXPR = { class: 'read', type: 'read', alias: 'read', query_location: 'any' } as const;
const REF = { type: 'read', alias: 'read', query_location: 'any', sample: SAMPLE } as const;
const NO_AGG_ORDER = { def: { type: 'ORDER_MODIFIER', orders: [] }, as: 'ORDER BY inside an aggregate' };

/** Shape → key → rule. The shape of a node is `shapeOf`'s. */
export const SHAPES: Record<string, Record<string, KeyRule>> = {
  // A parse error's root carries the rest; it is refused before any shape is read (tree.ts `statementOf`).
  root: { error: 'read', statements: 'read', error_type: 'any', error_message: 'any', error_subtype: 'any', position: 'any' },
  statement: { node: 'read', named_param_map: NONE('a named parameter') },
  'node:SELECT_NODE': {
    type: 'read', modifiers: 'read', cte_map: 'read', select_list: 'read', from_table: 'read', where_clause: 'read',
    group_expressions: 'read', group_sets: 'read', having: 'read',
    aggregate_handling: { def: 'STANDARD_HANDLING', as: 'GROUP BY ALL' }, sample: SAMPLE, qualify: { def: null, as: 'QUALIFY' },
  },
  'node:SET_OPERATION_NODE': { type: 'read', cte_map: 'read', setop_type: 'read', setop_all: 'read', left: 'read', right: 'read', modifiers: 'read' },
  ctemap: { map: 'read' },
  cteentry: { key: 'read', value: 'read' },
  cte: {
    query: 'read', aliases: NONE('column names after a CTE name'), key_targets: NONE('USING KEY'),
    materialized: { def: 'CTE_MATERIALIZE_DEFAULT', as: 'MATERIALIZED' },
  },
  'mod:ORDER_MODIFIER': { type: 'read', orders: 'read' },
  'mod:LIMIT_MODIFIER': { type: 'read', limit: 'read', offset: { def: null, as: 'OFFSET' } },
  'mod:DISTINCT_MODIFIER': { type: 'read', distinct_on_targets: NONE('DISTINCT ON') },
  order: { type: 'read', null_order: 'read', expression: 'read' },
  'ref:BASE_TABLE': {
    ...REF, schema_name: 'read', table_name: 'read', catalog_name: 'read', at_clause: AT,
    column_name_alias: NONE('column names after a table name'),
  },
  'ref:SUBQUERY': { ...REF, subquery: 'read', column_name_alias: NONE('column names after a subquery') },
  'ref:JOIN': {
    ...REF, left: 'read', right: 'read', condition: 'read', join_type: 'read', ref_type: 'read', using_columns: 'read',
    delim_flipped: { def: false, as: 'a flipped join' }, duplicate_eliminated_columns: NONE('a duplicate-eliminated join'),
  },
  'ref:EMPTY': { ...REF },
  'expr:COLUMN_REF': { ...EXPR, column_names: 'read' },
  'expr:CONSTANT': { ...EXPR, value: 'read' },
  'expr:FUNCTION': {
    ...EXPR, function_name: 'read', schema: 'read', catalog: { def: '', as: 'a function in another database' }, children: 'read',
    filter: { def: null, as: 'FILTER (WHERE …)' }, order_bys: NO_AGG_ORDER, distinct: 'read', is_operator: 'any',
    export_state: { def: false, as: 'EXPORT_STATE' },
  },
  'expr:COMPARISON': { ...EXPR, left: 'read', right: 'read' },
  'expr:CONJUNCTION': { ...EXPR, children: 'read' },
  'expr:OPERATOR': { ...EXPR, children: 'read' },
  'expr:CASE': { ...EXPR, case_checks: 'read', else_expr: 'read' },
  casecheck: { when_expr: 'read', then_expr: 'read' },
  'expr:CAST': { ...EXPR, child: 'read', cast_type: 'read', try_cast: { def: false, as: 'TRY_CAST' } },
  'expr:BETWEEN': { ...EXPR, input: 'read', lower: 'read', upper: 'read' },
  'expr:SUBQUERY': { ...EXPR, subquery: 'read', subquery_type: 'read', child: 'read', comparison_type: 'read' },
  'expr:WINDOW': {
    ...EXPR, function_name: 'read', schema: { def: '', as: 'a window function in another schema' }, catalog: { def: '', as: 'a window function in another database' },
    children: 'read', partitions: 'read', orders: 'read', start: 'read', end: 'read', start_expr: 'read', end_expr: 'read',
    offset_expr: 'read', default_expr: { def: null, as: 'a default value for lag or lead' }, filter_expr: { def: null, as: 'FILTER (WHERE …)' },
    ignore_nulls: { def: false, as: 'IGNORE NULLS' }, distinct: { def: false, as: 'DISTINCT inside a window function' },
    exclude_clause: { def: 'NO_OTHER', as: 'EXCLUDE in a window frame' }, arg_orders: NONE('ORDER BY inside a window function'),
  },
  'expr:STAR': {
    ...EXPR, relation_name: 'read', exclude_list: NONE('* EXCLUDE'), replace_list: NONE('* REPLACE'), rename_list: NONE('* RENAME'),
    qualified_exclude_list: NONE('* EXCLUDE'), columns: { def: false, as: 'COLUMNS(…)' }, expr: { def: null, as: 'COLUMNS(…)' },
  },
  value: { type: 'read', is_null: 'read', value: 'any' },
  logicaltype: { id: 'read', type_info: 'read' },
  'typeinfo:DECIMAL_TYPE_INFO': { type: 'read', alias: { def: '', as: 'a named type' }, extension_info: { def: null, as: 'a type extension' }, width: 'read', scale: 'read' },
};

/** Node shapes that are whole constructs F1 refuses, by the SQL a person would recognise. */
export const REFUSED: Record<string, string> = {
  'node:RECURSIVE_CTE_NODE': 'WITH RECURSIVE',
  'node:CTE_NODE': 'WITH … AS MATERIALIZED',
  'mod:LIMIT_PERCENT_MODIFIER': 'LIMIT … %',
  'ref:TABLE_FUNCTION': 'a table function',
  'ref:EXPRESSION_LIST': 'VALUES',
  'ref:PIVOT': 'PIVOT',
  'ref:SHOW_REF': 'SHOW',
  'ref:COLUMN_DATA': 'a materialized table',
  'ref:DELIM_GET': 'a correlated join',
  'expr:LAMBDA': 'a lambda (x -> …)',
  'expr:LAMBDA_REF': 'a lambda (x -> …)',
  'expr:COLLATE': 'COLLATE',
  'expr:PARAMETER': 'a placeholder ($1, ?)',
  'expr:POSITIONAL_REFERENCE': 'a positional reference (#1)',
  'expr:DEFAULT': 'DEFAULT',
};

/**
 * What a call becomes. `agg`: an aggregate (also OVER a window); `win`: a window-only function;
 * the rest one IR node each. Operators are calls in DuckDB's tree (`+`, `~~` for LIKE).
 */
export type FnKind =
  | 'agg' | 'win' | 'abs' | 'floor' | 'ceil' | 'trunc' | 'part' | 'nullif'
  | '+' | '-' | '*' | '/' | 'like' | 'notLike';

export const FUNCTIONS: Map<string, FnKind> = new Map<string, FnKind>([
  ['count_star', 'agg'], ['count', 'agg'], ['sum', 'agg'], ['avg', 'agg'], ['min', 'agg'], ['max', 'agg'],
  ['row_number', 'win'], ['rank', 'win'], ['dense_rank', 'win'], ['lag', 'win'], ['lead', 'win'],
  ['first_value', 'win'], ['last_value', 'win'],
  ['abs', 'abs'], ['floor', 'floor'], ['ceil', 'ceil'], ['ceiling', 'ceil'],
  ['date_trunc', 'trunc'], ['date_part', 'part'], ['nullif', 'nullif'],
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'], ['~~', 'like'], ['!~~', 'notLike'],
]);

type Node = Record<string, unknown>;
export const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

const QUERY_NODES = /_NODE$/;
const MODIFIERS = /_MODIFIER$/;
const ORDERS = new Set(['ASCENDING', 'DESCENDING', 'ORDER_DEFAULT', 'ORDER_INVALID']);

/** A node's shape, from the JSON alone (the census walks trees with no other context). */
export function shapeOf(n: Node): string {
  if (typeof n.class === 'string') return `expr:${n.class}`;
  if (isNode(n.type) && 'is_null' in n) return 'value';
  if (typeof n.type === 'string') {
    if (QUERY_NODES.test(n.type)) return `node:${n.type}`;
    if (MODIFIERS.test(n.type)) return `mod:${n.type}`;
    if (ORDERS.has(n.type) && 'expression' in n) return 'order';
    if (/_TYPE_INFO$/.test(n.type)) return `typeinfo:${n.type}`;
    return `ref:${n.type}`;
  }
  if ('statements' in n || 'error' in n) return 'root';
  if ('node' in n && 'named_param_map' in n) return 'statement';
  if ('id' in n && 'type_info' in n) return 'logicaltype';
  if ('map' in n) return 'ctemap';
  if ('key' in n && 'value' in n) return 'cteentry';
  if ('query' in n && 'materialized' in n) return 'cte';
  if ('when_expr' in n) return 'casecheck';
  return 'unknown';
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Why this node may not be read, as the construct it is, or null. Checks its shape is known and
 * every key it carries is classified, with any defaulted key at its default.
 */
export function shapeProblem(n: Node, shape: string = shapeOf(n)): string | null {
  if (REFUSED[shape]) return REFUSED[shape];
  const keys = SHAPES[shape];
  if (!keys) return shape;
  for (const [k, v] of Object.entries(n)) {
    const rule = keys[k];
    if (!rule) return k;
    if (typeof rule === 'object' && !same(v, rule.def)) return rule.as;
  }
  return null;
}
