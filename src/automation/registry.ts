// The automation COMMAND REGISTRY — MAIN PROCESS.
//
// ONE list, four front doors: `ordinate --cli <command>` (cli.ts), MCP over
// stdio (`--mcp`, headless.ts), MCP over loopback HTTP (httpTransport.ts,
// started by src/ipc/automation.ts) and, on the server, MCP at /api/mcp with
// a personal API token (serverMcp.ts). Each entry names its CLI words and/or its
// MCP tool, carries ONE argument schema — plain JSON Schema, handed verbatim to
// MCP clients as `inputSchema` and used by the CLI parser for its flags — and a
// handler that returns plain JSON. docs/automation.md is GENERATED from this
// file (docs.ts), and scripts/test-automation.ts fails when the committed doc
// differs, so the reference cannot drift from what the binary accepts.
//
// ── What is exposed, and what never is ─────────────────────────────────────
// Everything is READ-ONLY except `create_visual` and `create_dashboard`, which
// write RECORDS (a visual, an analysis) and never data — a plan's calculated
// fields are refused because they would add a column to a dataset. The two CLI
// commands that do change data (`datasets import`, `datasets refresh`) are the
// user's own shell acting on their own files, and are not MCP tools. No
// connection, config, key or secret is reachable from here: there is no
// connection tool, and every handler returns a WHITELISTED projection, never a
// stored record.

import { CHART_TYPE_IDS } from '../analysis/analysisPlan';
import * as h from './handlers';
import { AutomationError } from './errors';

export { AutomationError, EXIT } from './errors';
export type { ErrorCode } from './errors';

// ponytail: JSON Schema nodes are open-ended JSON; only the top level is typed.
export type JsonSchema = Record<string, unknown>;

export interface ArgSpec {
  type: 'string' | 'integer' | 'boolean' | 'object' | 'array';
  description: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  /** Nested JSON Schema for object/array arguments (MCP clients read it). */
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
}

export type Transport = 'cli' | 'stdio' | 'http';

export interface Ctx {
  /** The resolved project ('' for a command that takes none). */
  projectId: string;
  transport: Transport;
  /** Where relative CLI paths resolve. */
  cwd: string;
  /** A headless process (`--cli` / `--mcp`) rather than the GUI. */
  headless: boolean;
  /** A progress line — stderr on the CLI, dropped elsewhere. */
  progress: (note: string) => void;
  /** Server only (/api/mcp): the projects the caller may read. Absent = every project. */
  canRead?: (projectId: string) => boolean;
}

/**
 * Server only (serverMcp.ts): who the caller may act for. `canRead` trims
 * every project lookup, so another member's project is "not found", never
 * "forbidden"; `allow` decides whether THIS command may run in the project.
 */
export interface Scope {
  canRead(projectId: string): boolean;
  allow(cmd: Command, projectId: string): Promise<boolean>;
}

export type Args = Record<string, unknown>;

export interface Command {
  /** CLI words, e.g. 'datasets list'. Absent = not a CLI command. */
  cli?: string;
  /** MCP tool name, e.g. 'list_datasets'. Absent = not an MCP tool. */
  tool?: string;
  summary: string;
  args: Record<string, ArgSpec>;
  required?: string[];
  /** CLI positional order; the last may be `rest` (joins the remaining words). */
  positional?: string[];
  rest?: boolean;
  /** Arguments the CLI accepts but MCP does not (a file path to write). */
  cliOnly?: string[];
  /** CLI boolean shorthands: `--pdf` → { format: 'pdf' }. */
  cliFlags?: Record<string, [string, string]>;
  /** False when the command is not about one project. */
  project?: false;
  readOnly: boolean;
  /** What a non-read-only command changes, for the docs and the Settings list. */
  writes?: 'data' | 'files' | 'records';
  run: (args: Args, ctx: Ctx) => Promise<unknown>;
}

const PROJECT: ArgSpec = {
  type: 'string',
  description: 'Project id or exact name. Defaults to the project opened most recently in Ordinate.',
};

const FILTERS: ArgSpec = {
  type: 'array',
  description: 'Row filters applied before aggregation — the same filter steps a visual stores.',
  items: {
    type: 'object',
    properties: {
      column: { type: 'string' },
      op: { type: 'string', enum: ['=', '!=', '>', '<', '>=', '<=', 'contains', 'is_empty', 'not_empty', 'in', 'not in'] },
      value: { description: 'The comparison value (string, number or null).' },
      values: { type: 'array', description: "The value list for 'in' / 'not in'." },
    },
    required: ['column', 'op'],
  },
};

const ENCODING: ArgSpec = {
  type: 'object',
  description: 'What to chart: a category column and one or more measures, exactly as a visual stores it.',
  properties: {
    category: { type: 'string', description: 'The dimension (x axis / slices / rows).' },
    values: {
      type: 'array',
      description: 'Measures. sum/avg/min/max need a number column; count works on any column.',
      items: {
        type: 'object',
        properties: {
          column: { type: 'string' },
          aggregation: { type: 'string', enum: ['sum', 'avg', 'count', 'min', 'max', 'none'] },
        },
        required: ['column', 'aggregation'],
      },
    },
    series: { type: 'string', description: 'Optional split column (one series per value).' },
    grain: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'], description: 'Date bucketing for a date category.' },
    bins: { type: 'integer', minimum: 2, description: 'Histogram bucket count for a number category.' },
    pivot: { type: 'object', description: "Pivot tables only: { rows:[{column}], columns:[{column}], values:[{column, aggregation}] }." },
  },
  required: ['category', 'values'],
};

const EXPORT_FORMATS = ['pdf', 'png', 'html'] as const;

export const COMMANDS: readonly Command[] = [
  {
    cli: 'projects list', tool: 'list_projects', project: false, readOnly: true,
    summary: 'List projects, newest first, marking the default one.',
    args: {},
    run: (_a, ctx) => h.projectsList(ctx),
  },
  {
    cli: 'datasets list', tool: 'list_datasets', readOnly: true,
    summary: "List a project's datasets with row and column counts.",
    args: {},
    run: (_a, ctx) => h.datasetsList(ctx),
  },
  {
    cli: 'datasets describe', tool: 'describe_dataset', readOnly: true,
    summary: 'Columns, declared types and SQL names of one dataset. No rows.',
    args: { dataset: { type: 'string', description: 'Dataset id or exact name.' } },
    required: ['dataset'], positional: ['dataset'],
    run: (a, ctx) => h.datasetsDescribe(ctx, String(a.dataset)),
  },
  {
    cli: 'datasets import', readOnly: false, writes: 'data',
    summary: 'Import a .csv, .json or .xlsx file as a new dataset (runs as an import job).',
    args: {
      file: { type: 'string', description: 'Path to the file, relative to the current directory.' },
      name: { type: 'string', description: 'Dataset name. Defaults to the file name.' },
    },
    required: ['file'], positional: ['file'],
    run: (a, ctx) => h.datasetsImport(ctx, String(a.file), typeof a.name === 'string' ? a.name : ''),
  },
  {
    cli: 'datasets refresh', readOnly: false, writes: 'data',
    summary: 'Re-fetch a dataset from its source, then run its quality rules and alerts.',
    args: { dataset: { type: 'string', description: 'Dataset id or exact name.' } },
    required: ['dataset'], positional: ['dataset'],
    run: (a, ctx) => h.datasetsRefresh(ctx, String(a.dataset)),
  },
  {
    cli: 'query', tool: 'query_sql', readOnly: true, rest: true,
    summary: "Run one read-only SQL SELECT over the project's datasets, bounded to --limit rows.",
    args: {
      sql: { type: 'string', description: 'One SELECT statement. Datasets are tables named as `datasets describe` shows.' },
      limit: { type: 'integer', minimum: 1, maximum: 1_000_000, default: 500, description: 'Most rows returned (1 to 1,000,000).' },
    },
    required: ['sql'], positional: ['sql'],
    run: (a, ctx) => h.query(ctx, String(a.sql), typeof a.limit === 'number' ? a.limit : 500),
  },
  {
    tool: 'aggregate', readOnly: true,
    summary: 'Compute chart data (labels and series) for an encoding — the numbers a visual would draw.',
    args: { dataset: { type: 'string', description: 'Dataset id or exact name.' }, encoding: ENCODING, filters: FILTERS },
    required: ['dataset', 'encoding'],
    run: (a, ctx) => h.aggregate(ctx, a),
  },
  {
    cli: 'metrics list', tool: 'list_metrics', readOnly: true,
    summary: "List the project's saved metrics and how each is defined.",
    args: {},
    run: (_a, ctx) => h.metricsList(ctx),
  },
  {
    cli: 'metrics value', tool: 'metric_value', readOnly: true,
    summary: 'The current value of a saved metric, computed by the app and formatted by the metric.',
    args: { metric: { type: 'string', description: 'Metric name (case-insensitive) or id.' } },
    required: ['metric'], positional: ['metric'],
    run: (a, ctx) => h.metricValue(ctx, String(a.metric)),
  },
  {
    cli: 'insights', tool: 'insights', readOnly: true,
    summary: 'What the app found in a dataset: trends, movers, concentration and anomalies.',
    args: { dataset: { type: 'string', description: 'Dataset id or exact name.' } },
    required: ['dataset'], positional: ['dataset'],
    run: (a, ctx) => h.insights(ctx, String(a.dataset)),
  },
  {
    cli: 'dashboards list', tool: 'list_dashboards', readOnly: true,
    summary: 'List dashboards with their sheets and the reports built on them.',
    args: {},
    run: (_a, ctx) => h.dashboardsList(ctx),
  },
  {
    cli: 'dashboards export', tool: 'export_dashboard', readOnly: true,
    summary: 'Export a dashboard as one self-contained HTML page, a PDF or a PNG.',
    args: {
      dashboard: { type: 'string', description: 'Dashboard id or exact name.' },
      format: { type: 'string', enum: EXPORT_FORMATS, default: 'pdf', description: 'html, pdf or png.' },
      out: { type: 'string', description: 'Output file or folder. Default: ./<dashboard name>.<ext>. Over MCP the file always goes to Downloads/Ordinate.' },
    },
    required: ['dashboard'], positional: ['dashboard'], cliOnly: ['out'],
    cliFlags: { pdf: ['format', 'pdf'], png: ['format', 'png'], html: ['format', 'html'] },
    run: (a, ctx) => h.dashboardsExport(ctx, String(a.dashboard), String(a.format || 'pdf'), typeof a.out === 'string' ? a.out : ''),
  },
  {
    cli: 'reports run', tool: 'run_report', readOnly: true,
    summary: "Generate a saved report (PDF, PPTX or DOCX) through the app's own report renderer.",
    args: {
      report: { type: 'string', description: 'Report id or exact name.' },
      out: { type: 'string', description: 'Output file or folder. Default: the current directory. Over MCP the file always goes to Downloads/Ordinate.' },
    },
    required: ['report'], positional: ['report'], cliOnly: ['out'],
    run: (a, ctx) => h.reportsRun(ctx, String(a.report), typeof a.out === 'string' ? a.out : ''),
  },
  {
    cli: 'publish', readOnly: false, writes: 'files',
    summary: 'Publish dashboards to a static folder from a publish config file (runs as a publish job).',
    args: { config: { type: 'string', description: 'Path to a publish config JSON: { projectId?, dashboardIds, storyIds, scorecardIds?, outDir, options }.' } },
    required: ['config'], positional: ['config'],
    run: (a, ctx) => h.publish(ctx, String(a.config)),
  },
  {
    tool: 'create_visual', readOnly: false, writes: 'records',
    summary: 'Save a new visual. Validated exactly as the app validates a chart; writes a record, never data. Logged in Jobs.',
    args: {
      dataset: { type: 'string', description: 'Dataset id or exact name.' },
      name: { type: 'string', description: 'Visual name.' },
      chartType: { type: 'string', enum: [...CHART_TYPE_IDS], description: 'One of the app chart types.' },
      encoding: ENCODING,
      filters: FILTERS,
    },
    required: ['dataset', 'name', 'chartType', 'encoding'],
    run: (a, ctx) => h.createVisual(ctx, a),
  },
  {
    tool: 'create_dashboard', readOnly: false, writes: 'records',
    summary: 'Build a new dashboard from a plan, validated by the same validator as the Assistant; reports what was dropped. Writes records, never data. Logged in Jobs.',
    args: {
      plan: {
        type: 'object',
        description: 'A dashboard plan: { name, sheets:[{ name, metrics?, visuals?, texts?, controls? }] }. Visuals are { dataset, name, chartType, encoding, filters? } or { visual: <saved visual name or id> }; metrics are { dataset, column, aggregation, label? }; texts are { heading?, text? }. Calculated fields are refused.',
        properties: {
          name: { type: 'string' },
          sheets: { type: 'array', items: { type: 'object' } },
        },
        required: ['name', 'sheets'],
      },
    },
    required: ['plan'],
    run: (a, ctx) => h.createDashboard(ctx, a.plan),
  },
];

/** The CLI command for these words, or null. */
export function findCli(words: string): Command | null {
  return COMMANDS.find((c) => c.cli === words) || null;
}

/** The MCP tool of this name, or null. */
export function findTool(name: string): Command | null {
  return COMMANDS.find((c) => c.tool === name) || null;
}

/** Every argument the command takes on this transport, `project` included. */
export function argSpecs(cmd: Command, transport: Transport): Record<string, ArgSpec> {
  const out: Record<string, ArgSpec> = cmd.project === false ? {} : { project: PROJECT };
  for (const [k, v] of Object.entries(cmd.args)) {
    if (transport !== 'cli' && cmd.cliOnly && cmd.cliOnly.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** The MCP `inputSchema` — the registry's own schema, `project` included. */
export function inputSchema(cmd: Command): JsonSchema {
  const schema: JsonSchema = { type: 'object', properties: argSpecs(cmd, 'stdio'), additionalProperties: false };
  if (cmd.required && cmd.required.length) schema.required = cmd.required.slice();
  return schema;
}

/**
 * Top-level argument check, shared by the CLI and MCP: unknown names, types,
 * enums, bounds and required. Nested shapes (an encoding, a plan) are NOT
 * judged here — the app's own validators judge them in the handler, so an
 * automation caller is held to exactly the rules a UI edit is.
 */
export function validateArgs(cmd: Command, raw: unknown, transport: Transport): Args {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new AutomationError('usage', 'Arguments must be an object.', 'args');
  const specs = argSpecs(cmd, transport);
  const out: Args = {};
  for (const [k, v] of Object.entries(raw as Args)) {
    const spec = specs[k];
    if (!spec) throw new AutomationError('usage', `Unknown argument "${k}".`, 'args');
    if (v === undefined) continue;
    const bad = (want: string): AutomationError => new AutomationError('usage', `"${k}" must be ${want}.`, 'args');
    if (spec.type === 'string' && typeof v !== 'string') throw bad('a string');
    if (spec.type === 'boolean' && typeof v !== 'boolean') throw bad('true or false');
    if (spec.type === 'integer') {
      if (typeof v !== 'number' || !Number.isInteger(v)) throw bad('a whole number');
      if (spec.minimum !== undefined && v < spec.minimum) throw bad(`at least ${spec.minimum}`);
      if (spec.maximum !== undefined && v > spec.maximum) throw bad(`at most ${spec.maximum.toLocaleString('en-US')}`);
    }
    if (spec.type === 'object' && (!v || typeof v !== 'object' || Array.isArray(v))) throw bad('an object');
    if (spec.type === 'array' && !Array.isArray(v)) throw bad('an array');
    if (spec.enum && !spec.enum.includes(v as string)) throw bad('one of ' + spec.enum.join(', '));
    out[k] = v;
  }
  for (const k of cmd.required || []) {
    const v = out[k];
    if (v === undefined || (typeof v === 'string' && !v.trim())) throw new AutomationError('usage', `Missing "${k}".`, 'args');
  }
  return out;
}

/**
 * THE one entry point every front door calls: validate, resolve the project,
 * run. Throws AutomationError (or anything the handler throws).
 */
export async function dispatch(
  cmd: Command,
  raw: unknown,
  opts: { transport: Transport; cwd?: string; headless: boolean; progress?: (note: string) => void; scope?: Scope },
): Promise<unknown> {
  const args = validateArgs(cmd, raw, opts.transport);
  const scope = opts.scope;
  const projectId = cmd.project === false ? '' : (await h.resolveProject(args.project as string | undefined, scope?.canRead)).id;
  if (scope && projectId && !(await scope.allow(cmd, projectId))) {
    throw new AutomationError('usage', `${cmd.tool || cmd.cli} needs ${cmd.readOnly ? 'viewer' : 'editor'} access to this project.`);
  }
  return cmd.run(args, {
    ...(scope ? { canRead: (id: string) => scope.canRead(id) } : {}),
    projectId,
    transport: opts.transport,
    cwd: opts.cwd || process.cwd(),
    headless: opts.headless,
    progress: opts.progress || (() => {}),
  });
}
