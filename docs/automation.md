# Automation — the CLI and the local MCP server

<!-- GENERATED from src/automation/registry.ts by `node scripts/gen-automation-docs.js`.
     Do not edit by hand: scripts/test-automation.ts fails when this file differs. -->

Ordinate can be driven without its window: from a shell (`--cli`), and by tools such as Claude Code through a local
MCP server (`--mcp` over stdio, or a loopback HTTP endpoint). All three go through ONE command
registry, so a command means the same thing, with the same arguments and the same validation,
wherever it is called from. Every figure is computed by the app; nothing here lets a caller write one.

## Command line

```sh
<binary> --cli <command> [arguments] [options]
<binary> --cli help                 # every command
<binary> --cli help <command>       # one command
```

`<binary>` was the desktop app, removed at the server cutover (T8.1). Until the server gains a
command-line entry point, its automation surface is the MCP endpoint (`/mcp`, src/automation/serverMcp.ts).

A CLI run is headless — no window, no dock icon, no schedules, no notifications — and works while
the app is open. **The CLI is always available**: it is your own shell running the app on your own
files, so it is not behind the Automation switch. Jobs it runs (imports, refreshes, publishes) still
appear in the app's Jobs popover.

| Option | Meaning |
| --- | --- |
| `--project <id\|name>` | The project to work in. Default: the one opened most recently (never an archived one). |
| `--json` | Exactly one JSON document on stdout: `{"ok":true,"result":…}`, or `{"ok":false,"error":"…","code":"…"}`. |
| `--verbose` | Also print the app's own log lines (to stderr). |
| `--help` | Help for everything, or for the command it follows. |
| `--` | Everything after it is a plain argument, even if it starts with `--`. |

Values that contain spaces must be quoted — `query "SELECT region, sum(amount) FROM sales GROUP BY 1"`.
Errors and progress lines always go to stderr, so stdout carries only the answer.

| Exit code | Meaning |
| --- | --- |
| 0 | OK |
| 1 | The command ran and failed (a SQL error, a file that could not be written) |
| 2 | Usage: unknown command or option, a missing or malformed argument, an invalid spec |
| 3 | Not found: no such project, dataset, dashboard, report, metric or file |
| 4 | Automation is turned off (`--mcp` only) |

## MCP server

Off by default. Turn it on in **Settings → Automation**. Two transports:

- **stdio** — the client starts the app headless and speaks newline-delimited JSON-RPC 2.0 on its
  stdin/stdout. For Claude Code: `claude mcp add ordinate -- "<binary>" --mcp`. It refuses to start
  (exit 4) while Automation is off, and re-checks the switch on every tool call.
- **HTTP** — a second opt-in, served by the running app at `http://127.0.0.1:<port>/mcp` (port 7719
  unless changed). `POST` one JSON-RPC message, get one JSON response back.

Methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Arguments
that fail a tool's schema are a JSON-RPC `-32602`; a tool that runs and fails returns `isError: true`
with the reason. Results carry the JSON as text, and as `structuredContent` when it is an object.

### Security

- Every tool is **read-only** except `create_visual` and `create_dashboard`, which save a visual or a
  dashboard RECORD — never data — are validated by the same validator the Assistant's plans go through,
  and appear in the Jobs popover. A plan's calculated fields are refused: they would add a column to
  a dataset.
- Connections are not exposed. No output ever contains config, API keys, connection passwords or
  tokens. A dataset's origin is reported by KIND only (`file`, `url`, `sql`…) — never its path, URL,
  query or connection id.
- HTTP listens on **127.0.0.1 only** and needs `Authorization: Bearer <token>`. The token is made when
  the server starts, kept in memory only (never written to disk), shown once in Settings, and
  replaced by Regenerate or by restarting the app. Requests whose `Host` is not localhost/127.0.0.1,
  or whose `Origin` is not a loopback page, are refused (DNS-rebinding guard). Bodies over 1 MB are
  refused.
- Files: over MCP, `export_dashboard` and `run_report` always write a NEW file into
  `Downloads/Ordinate` and return its path — a caller never chooses where a file is written.
- A report containing a map cannot run headless (maps need the visible window's WebGL2); it fails
  with a message instead of hanging.

## Commands

| CLI | MCP tool | Access | What it does |
| --- | --- | --- | --- |
| `projects list` | `list_projects` | read | List projects, newest first, marking the default one. |
| `datasets list` | `list_datasets` | read | List a project's datasets with row and column counts. |
| `datasets describe` | `describe_dataset` | read | Columns, declared types and SQL names of one dataset. No rows. |
| `datasets import` | — | writes data | Import a .csv, .json or .xlsx file as a new dataset (runs as an import job). |
| `datasets refresh` | — | writes data | Re-fetch a dataset from its source, then run its quality rules and alerts. |
| `query` | `query_sql` | read | Run one read-only SQL SELECT over the project's datasets, bounded to --limit rows. |
| — | `aggregate` | read | Compute chart data (labels and series) for an encoding — the numbers a visual would draw. |
| `metrics list` | `list_metrics` | read | List the project's saved metrics and how each is defined. |
| `metrics value` | `metric_value` | read | The current value of a saved metric, computed by the app and formatted by the metric. |
| `insights` | `insights` | read | What the app found in a dataset: trends, movers, concentration and anomalies. |
| `dashboards list` | `list_dashboards` | read | List dashboards with their sheets and the reports built on them. |
| `dashboards export` | `export_dashboard` | read | Export a dashboard as one self-contained HTML page, a PDF or a PNG. |
| `reports run` | `run_report` | read | Generate a saved report (PDF, PPTX or DOCX) through the app's own report renderer. |
| `publish` | — | writes files | Publish dashboards to a static folder from a publish config file (runs as a publish job). |
| — | `create_visual` | writes records | Save a new visual. Validated exactly as the app validates a chart; writes a record, never data. Logged in Jobs. |
| — | `create_dashboard` | writes records | Build a new dashboard from a plan, validated by the same validator as the Assistant; reports what was dropped. Writes records, never data. Logged in Jobs. |

### projects list

CLI `projects list` · MCP tool `list_projects` · read-only

List projects, newest first, marking the default one.

### datasets list

CLI `datasets list` · MCP tool `list_datasets` · read-only

List a project's datasets with row and column counts.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | string | no | Project id or exact name; `--project` on the CLI. Defaults to the project opened most recently. |

### datasets describe

CLI `datasets describe <dataset>` · MCP tool `describe_dataset` · read-only

Columns, declared types and SQL names of one dataset. No rows.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | string | no | Project id or exact name; `--project` on the CLI. Defaults to the project opened most recently. |
| `dataset` | string | yes | Dataset id or exact name. |

### datasets import

CLI `datasets import <file> [--name <name>]` · CLI only · **writes data**

Import a .csv, .json or .xlsx file as a new dataset (runs as an import job).

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | string | no | Project id or exact name; `--project` on the CLI. Defaults to the project opened most recently. |
| `file` | string | yes | Path to the file, relative to the current directory. |
| `name` | string | no | Dataset name. Defaults to the file name. |

### datasets refresh

CLI `datasets refresh <dataset>` · CLI only · **writes data**

Re-fetch a dataset from its source, then run its quality rules and alerts.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | string | no | Project id or exact name; `--project` on the CLI. Defaults to the project opened most recently. |
| `dataset` | string | yes | Dataset id or exact name. |

### query

CLI `query <sql> [--limit <n>]` · MCP tool `query_sql` · read-only

Run one read-only SQL SELECT over the project's datasets, bounded to --limit rows.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | string | no | Project id or exact name; `--project` on the CLI. Defaults to the project opened most recently. |
| `sql` | string | yes | One SELECT statement. Datasets are tables named as `datasets describe` shows. |
| `limit` | integer (1–1,000,000) | no | Most rows returned (1 to 1,000,000). Default `500`. |

### aggregate

MCP only · MCP tool `aggregate` · read-only

Compute chart data (labels and series) for an encoding — the numbers a visual would draw.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | string | no | Project id or exact name; `--project` on the CLI. Defaults to the project opened most recently. |
| `dataset` | string | yes | Dataset id or exact name. |
| `encoding` | object | yes | What to chart: a category column and one or more measures, exactly as a visual stores it. |
| `filters` | array | no | Row filters applied before aggregation — the same filter steps a visual stores. |

### metrics list

CLI `metrics list` · MCP tool `list_metrics` · read-only

List the project's saved metrics and how each is defined.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | string | no | Project id or exact name; `--project` on the CLI. Defaults to the project opened most recently. |

### metrics value

CLI `metrics value <metric>` · MCP tool `metric_value` · read-only

The current value of a saved metric, computed by the app and formatted by the metric.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | string | no | Project id or exact name; `--project` on the CLI. Defaults to the project opened most recently. |
| `metric` | string | yes | Metric name (case-insensitive) or id. |

### insights

CLI `insights <dataset>` · MCP tool `insights` · read-only

What the app found in a dataset: trends, movers, concentration and anomalies.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | string | no | Project id or exact name; `--project` on the CLI. Defaults to the project opened most recently. |
| `dataset` | string | yes | Dataset id or exact name. |

### dashboards list

CLI `dashboards list` · MCP tool `list_dashboards` · read-only

List dashboards with their sheets and the reports built on them.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | string | no | Project id or exact name; `--project` on the CLI. Defaults to the project opened most recently. |

### dashboards export

CLI `dashboards export <dashboard> [--pdf|--png|--html] [--out <out>]` · MCP tool `export_dashboard` · read-only

Export a dashboard as one self-contained HTML page, a PDF or a PNG.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | string | no | Project id or exact name; `--project` on the CLI. Defaults to the project opened most recently. |
| `dashboard` | string | yes | Dashboard id or exact name. |
| `format` | `pdf` \| `png` \| `html` | no | html, pdf or png. Default `pdf`. |
| `out` | string | no | Output file or folder. Default: ./<dashboard name>.<ext>. Over MCP the file always goes to Downloads/Ordinate. *(CLI only.)* |

CLI shorthands: `--pdf` = `format: pdf`, `--png` = `format: png`, `--html` = `format: html`.

### reports run

CLI `reports run <report> [--out <out>]` · MCP tool `run_report` · read-only

Generate a saved report (PDF, PPTX or DOCX) through the app's own report renderer.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | string | no | Project id or exact name; `--project` on the CLI. Defaults to the project opened most recently. |
| `report` | string | yes | Report id or exact name. |
| `out` | string | no | Output file or folder. Default: the current directory. Over MCP the file always goes to Downloads/Ordinate. *(CLI only.)* |

### publish

CLI `publish <config>` · CLI only · **writes files**

Publish dashboards to a static folder from a publish config file (runs as a publish job).

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | string | no | Project id or exact name; `--project` on the CLI. Defaults to the project opened most recently. |
| `config` | string | yes | Path to a publish config JSON: { projectId?, dashboardIds, storyIds, scorecardIds?, outDir, options }. |

### create_visual

MCP only · MCP tool `create_visual` · **writes records**

Save a new visual. Validated exactly as the app validates a chart; writes a record, never data. Logged in Jobs.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | string | no | Project id or exact name; `--project` on the CLI. Defaults to the project opened most recently. |
| `dataset` | string | yes | Dataset id or exact name. |
| `name` | string | yes | Visual name. |
| `chartType` | `column` \| `bar` \| `clustered_column` \| `clustered_bar` \| `stacked_column` \| `stacked_bar` \| `pct_stacked_column` \| `pct_stacked_bar` \| `line` \| `line_markers` \| `area` \| `stacked_area` \| `pie` \| `donut` \| `scatter` \| `gauge` \| `combo` \| `bubble` \| `treemap` \| `heatmap` \| `funnel` \| `histogram` \| `sankey` \| `candlestick` \| `boxplot` \| `pivot` \| `cohort` \| `event_funnel` \| `waterfall` \| `bullet` \| `calendar` \| `radar` \| `pareto` \| `table` \| `map_bubble` \| `map_choropleth` \| `word_cloud` | yes | One of the app chart types. |
| `encoding` | object | yes | What to chart: a category column and one or more measures, exactly as a visual stores it. |
| `filters` | array | no | Row filters applied before aggregation — the same filter steps a visual stores. |

### create_dashboard

MCP only · MCP tool `create_dashboard` · **writes records**

Build a new dashboard from a plan, validated by the same validator as the Assistant; reports what was dropped. Writes records, never data. Logged in Jobs.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | string | no | Project id or exact name; `--project` on the CLI. Defaults to the project opened most recently. |
| `plan` | object | yes | A dashboard plan: { name, sheets:[{ name, metrics?, visuals?, texts?, controls? }] }. Visuals are { dataset, name, chartType, encoding, filters? } or { visual: <saved visual name or id> }; metrics are { dataset, column, aggregation, label? }; texts are { heading?, text? }. Calculated fields are refused. |

