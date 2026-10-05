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
    '# Automation — the MCP endpoint',
    '',
    '<!-- GENERATED from src/automation/registry.ts by `node scripts/gen-automation-docs.js`.',
    '     Do not edit by hand: scripts/test-automation.ts fails when this file differs. -->',
    '',
    'Programs (Claude Code, scripts, other agents) drive Ordinate through ONE command registry, so a',
    'command means the same thing, with the same arguments and the same validation, wherever it is',
    'called from. Every figure is computed by the server; nothing here lets a caller write one.',
    '',
    'On the server the live surface is the **MCP endpoint, `POST /api/mcp`**',
    '(src/automation/serverMcp.ts). The registry also defines a command line (`--cli`) and a stdio MCP',
    'transport (`--mcp`) in src/automation/cli.ts and argv.ts, but their only entry point was the',
    'desktop app, deleted at the server cutover (T8.1): **neither can be run today.** Wiring a Node',
    'entry point for them, or deleting them, is an open follow-up. Their reference is kept below because',
    'the registry still defines it.',
    '',
    '## MCP endpoint',
    '',
    '- **Sign-in:** a personal API token, `Authorization: Bearer ord_…`, made on the **API tokens** page',
    '  (`/tokens`). A browser session or cookie is not accepted (401): this door is for programs.',
    '- **Transport:** `POST` one JSON-RPC 2.0 message, get one JSON response back (`202` for a',
    '  notification). `GET` is `405`; batches are refused; bodies over 1 MB are refused. An `Origin`',
    '  header, when present, must be this server\'s own (`403` otherwise).',
    '- **Who runs it:** every call runs as the token\'s user with their CURRENT role. Projects they cannot',
    '  read do not exist for them (lists are trimmed, a name or id is "not found"); a tool that writes',
    '  records needs editor on its project and is audited as channel `mcp:<tool>`. A revoked token or a',
    '  disabled user is `401`.',
    '- **Limits:** calls spend the same per-user and per-IP budgets as the RPC API',
    '  (`RATE_LIMIT_RPC_PER_MINUTE`, `RATE_LIMIT_RPC_IP_PER_MINUTE`).',
    '- **Not offered here:** `export_dashboard` and `run_report`. They drew through the desktop app\'s',
    '  window, which no longer exists. Every other MCP tool in the table below is served.',
    '',
    '```sh',
    'curl -s https://<your host>/api/mcp \\',
    '  -H "Authorization: Bearer $ORDINATE_TOKEN" -H "Content-Type: application/json" \\',
    '  -d \'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\'',
    '```',
    '',
    'Methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Arguments',
    'that fail a tool\'s schema are a JSON-RPC `-32602`; a tool that runs and fails returns `isError: true`',
    'with the reason. Results carry the JSON as text, and as `structuredContent` when it is an object.',
    '',
    '### Security',
    '',
    '- Every tool is **read-only** except `create_visual` and `create_dashboard`, which save a visual or a',
    '  dashboard RECORD — never data — and are validated by the same validator the Assistant\'s plans go',
    '  through. A plan\'s calculated fields are refused: they would add a column to a dataset.',
    '- Connections are not exposed. No output ever contains config, API keys, connection passwords or',
    '  tokens. A dataset\'s origin is reported by KIND only (`file`, `url`, `sql`…) — never its path, URL,',
    '  query or connection id.',
    '- `query_sql` runs one read-only statement through the same SQL gate as the SQL workbench, in the',
    '  caller\'s org-locked DuckDB worker.',
    '',
    '## Command line (not runnable since T8.1)',
    '',
    'The registry\'s command-line form, kept as the reference for whichever entry point replaces it:',
    '',
    '```sh',
    '<binary> --cli <command> [arguments] [options]',
    '<binary> --cli help                 # every command',
    '<binary> --cli help <command>       # one command',
    '```',
    '',
    '| Option | Meaning |',
    '| --- | --- |',
    '| `--project <id\\|name>` | The project to work in. Default: the one opened most recently (never an archived one). |',
    '| `--json` | Exactly one JSON document on stdout: `{"ok":true,"result":…}`, or `{"ok":false,"error":"…","code":"…"}`. |',
    '| `--verbose` | Also print the app\'s own log lines (to stderr). |',
    '| `--help` | Help for everything, or for the command it follows. |',
    '| `--` | Everything after it is a plain argument, even if it starts with `--`. |',
    '',
    '| Exit code | Meaning |',
    '| --- | --- |',
    `| ${EXIT.ok} | OK |`,
    `| ${EXIT.runtime} | The command ran and failed (a SQL error, a file that could not be written) |`,
    `| ${EXIT.usage} | Usage: unknown command or option, a missing or malformed argument, an invalid spec |`,
    `| ${EXIT.not_found} | Not found: no such project, dataset, dashboard, report, metric or file |`,
    `| ${EXIT.disabled} | Automation is turned off (\`--mcp\` only) |`,
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
