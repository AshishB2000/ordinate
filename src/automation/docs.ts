// docs/automation.md, GENERATED from the command registry — pure.
//
// `node scripts/gen-automation-docs.js` writes it; scripts/test-automation.ts
// regenerates it in memory and fails when the committed file differs, so the
// reference cannot describe a flag the binary no longer accepts.

import { EXIT } from './errors';
import { cliSignature } from './cli';
import type { ArgSpec, Command } from './registry';

function argRow(name: string, spec: ArgSpec, required: boolean, note = ''): string {
  let type: string = spec.type;
  if (spec.enum) type = spec.enum.map((v) => '`' + v + '`').join(' \\| ');
  const bounds = spec.minimum !== undefined && spec.maximum !== undefined
    ? ` (${spec.minimum.toLocaleString('en-US')}–${spec.maximum.toLocaleString('en-US')})` : '';
  const dflt = spec.default !== undefined ? ` Default \`${String(spec.default)}\`.` : '';
  return `| \`${name}\` | ${type}${bounds} | ${required ? 'yes' : 'no'} | ${spec.description}${dflt}${note} |`;
}

function commandSection(c: Command): string {
  const title = c.cli || c.tool || '';
  const where = [
    c.cli ? `CLI \`${cliSignature(c)}\`` : 'MCP only',
    c.tool ? `MCP tool \`${c.tool}\`` : 'CLI only',
    c.readOnly ? 'read-only' : `**writes ${c.writes || 'data'}**`,
  ].join(' · ');
  const lines = [`### ${title}`, '', where, '', c.summary, ''];
  const rows: string[] = [];
  if (c.project !== false) rows.push(argRow('project', { type: 'string', description: 'Project id or exact name; `--project` on the CLI. Defaults to the project opened most recently.' }, false));
  for (const [k, spec] of Object.entries(c.args)) {
    const note = c.cliOnly && c.cliOnly.includes(k) ? ' *(CLI only.)*' : '';
    rows.push(argRow(k, spec, (c.required || []).includes(k), note));
  }
  if (rows.length) lines.push('| Argument | Type | Required | Description |', '| --- | --- | --- | --- |', ...rows, '');
  if (c.cliFlags) {
    lines.push('CLI shorthands: ' + Object.entries(c.cliFlags).map(([f, [a, v]]) => `\`--${f}\` = \`${a}: ${v}\``).join(', ') + '.', '');
  }
  return lines.join('\n');
}

export function generateDocs(commands: readonly Command[]): string {
  const index = commands.map((c) =>
    `| ${c.cli ? '`' + c.cli + '`' : '—'} | ${c.tool ? '`' + c.tool + '`' : '—'} | ${c.readOnly ? 'read' : 'writes ' + (c.writes || 'data')} | ${c.summary} |`);
  return [
    '# Automation — the CLI and the local MCP server',
    '',
    '<!-- GENERATED from src/automation/registry.ts by `node scripts/gen-automation-docs.js`.',
    '     Do not edit by hand: scripts/test-automation.ts fails when this file differs. -->',
    '',
    'Ordinate can be driven without its window: from a shell (`--cli`), and by tools such as Claude Code through a local',
    'MCP server (`--mcp` over stdio, or a loopback HTTP endpoint). All three go through ONE command',
    'registry, so a command means the same thing, with the same arguments and the same validation,',
    'wherever it is called from. Every figure is computed by the app; nothing here lets a caller write one.',
    '',
    '## Command line',
    '',
    '```sh',
    '<binary> --cli <command> [arguments] [options]',
    '<binary> --cli help                 # every command',
    '<binary> --cli help <command>       # one command',
    '```',
    '',
    '`<binary>` was the desktop app, removed at the server cutover (T8.1). Until the server gains a',
    'command-line entry point, its automation surface is the MCP endpoint (`/mcp`, src/automation/serverMcp.ts).',
    '',
    'A CLI run is headless — no window, no dock icon, no schedules, no notifications — and works while',
    'the app is open. **The CLI is always available**: it is your own shell running the app on your own',
    'files, so it is not behind the Automation switch. Jobs it runs (imports, refreshes, publishes) still',
    'appear in the app\'s Jobs popover.',
    '',
    '| Option | Meaning |',
    '| --- | --- |',
    '| `--project <id\\|name>` | The project to work in. Default: the one opened most recently (never an archived one). |',
    '| `--json` | Exactly one JSON document on stdout: `{"ok":true,"result":…}`, or `{"ok":false,"error":"…","code":"…"}`. |',
    '| `--verbose` | Also print the app\'s own log lines (to stderr). |',
    '| `--help` | Help for everything, or for the command it follows. |',
    '| `--` | Everything after it is a plain argument, even if it starts with `--`. |',
    '',
    'Values that contain spaces must be quoted — `query "SELECT region, sum(amount) FROM sales GROUP BY 1"`.',
    'Errors and progress lines always go to stderr, so stdout carries only the answer.',
    '',
    '| Exit code | Meaning |',
    '| --- | --- |',
    `| ${EXIT.ok} | OK |`,
    `| ${EXIT.runtime} | The command ran and failed (a SQL error, a file that could not be written) |`,
    `| ${EXIT.usage} | Usage: unknown command or option, a missing or malformed argument, an invalid spec |`,
    `| ${EXIT.not_found} | Not found: no such project, dataset, dashboard, report, metric or file |`,
    `| ${EXIT.disabled} | Automation is turned off (\`--mcp\` only) |`,
    '',
    '## MCP server',
    '',
    'Off by default. Turn it on in **Settings → Automation**. Two transports:',
    '',
    '- **stdio** — the client starts the app headless and speaks newline-delimited JSON-RPC 2.0 on its',
    '  stdin/stdout. For Claude Code: `claude mcp add ordinate -- "<binary>" --mcp`. It refuses to start',
    `  (exit ${EXIT.disabled}) while Automation is off, and re-checks the switch on every tool call.`,
    '- **HTTP** — a second opt-in, served by the running app at `http://127.0.0.1:<port>/mcp` (port 7719',
    '  unless changed). `POST` one JSON-RPC message, get one JSON response back.',
    '',
    'Methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Arguments',
    'that fail a tool\'s schema are a JSON-RPC `-32602`; a tool that runs and fails returns `isError: true`',
    'with the reason. Results carry the JSON as text, and as `structuredContent` when it is an object.',
    '',
    '### Security',
    '',
    '- Every tool is **read-only** except `create_visual` and `create_dashboard`, which save a visual or a',
    '  dashboard RECORD — never data — are validated by the same validator the Assistant\'s plans go through,',
    '  and appear in the Jobs popover. A plan\'s calculated fields are refused: they would add a column to',
    '  a dataset.',
    '- Connections are not exposed. No output ever contains config, API keys, connection passwords or',
    '  tokens. A dataset\'s origin is reported by KIND only (`file`, `url`, `sql`…) — never its path, URL,',
    '  query or connection id.',
    '- HTTP listens on **127.0.0.1 only** and needs `Authorization: Bearer <token>`. The token is made when',
    '  the server starts, kept in memory only (never written to disk), shown once in Settings, and',
    '  replaced by Regenerate or by restarting the app. Requests whose `Host` is not localhost/127.0.0.1,',
    '  or whose `Origin` is not a loopback page, are refused (DNS-rebinding guard). Bodies over 1 MB are',
    '  refused.',
    '- Files: over MCP, `export_dashboard` and `run_report` always write a NEW file into',
    '  `Downloads/Ordinate` and return its path — a caller never chooses where a file is written.',
    '- A report containing a map cannot run headless (maps need the visible window\'s WebGL2); it fails',
    '  with a message instead of hanging.',
    '',
    '## Commands',
    '',
    '| CLI | MCP tool | Access | What it does |',
    '| --- | --- | --- | --- |',
    ...index,
    '',
    ...commands.map(commandSection),
  ].join('\n');
}
