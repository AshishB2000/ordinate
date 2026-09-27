// `ordinate --cli <command>` — the command line over the registry.
//
// Output contract (docs/automation.md): with --json, stdout carries exactly one
// JSON document — `{"ok":true,"result":…}` or `{"ok":false,"error":…,"code":…}`;
// without it, a readable table or key/value list. Errors and progress always go
// to stderr, so a pipe only ever sees the answer. The exit code is the error's
// class (errors.ts EXIT), never a guess.

import { AutomationError, EXIT } from './errors';
import type { ErrorCode } from './errors';
import { parseCli } from './argv';
import type { Command, Transport } from './registry';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

type Dispatch = (cmd: Command, raw: unknown, opts: {
  transport: Transport; cwd?: string; headless: boolean; progress?: (note: string) => void;
}) => Promise<unknown>;

export interface CliOptions {
  headless: boolean;
  cwd?: string;
  /** Injected by the tests; the real registry otherwise. */
  commands?: readonly Command[];
  dispatch?: Dispatch;
}

export async function runCli(argv: readonly string[], io: CliIo, opts: CliOptions): Promise<number> {
  const registry = opts.commands && opts.dispatch ? null : (require('./registry') as typeof import('./registry'));
  const commands = opts.commands || registry!.COMMANDS;
  const dispatch: Dispatch = opts.dispatch || registry!.dispatch;
  // Known before parsing, so a usage error is still answered in JSON.
  const json = argv.includes('--json');
  const fail = (code: ErrorCode, message: string): number => {
    io.err('ordinate: ' + message);
    if (json) io.out(JSON.stringify({ ok: false, error: message, code }));
    return EXIT[code];
  };

  let parsed;
  try {
    parsed = parseCli(argv, commands);
  } catch (e) {
    return fail(e instanceof AutomationError ? e.code : 'usage', (e as Error).message);
  }
  if (parsed.help) {
    io.out(parsed.cmd ? commandHelp(parsed.cmd) : usage(commands));
    return argv.length ? EXIT.ok : EXIT.usage;
  }
  const cmd = parsed.cmd as Command;
  try {
    const result = await dispatch(cmd, parsed.args, {
      transport: 'cli', cwd: opts.cwd, headless: opts.headless, progress: (note) => io.err(note),
    });
    io.out(json ? JSON.stringify({ ok: true, result }) : formatText(result));
    return EXIT.ok;
  } catch (e) {
    if (e instanceof AutomationError) return fail(e.code, e.message);
    return fail('runtime', (e instanceof Error && e.message) || 'Something went wrong.');
  }
}

// ── Help ─────────────────────────────────────────────────────────────────────

/** `datasets describe <dataset> [--out <path>]` — shared with docs.ts. */
export function cliSignature(cmd: Command): string {
  const parts = [cmd.cli || ''];
  for (const p of cmd.positional || []) parts.push((cmd.required || []).includes(p) ? `<${p}>` : `[${p}]`);
  const shorts = Object.keys(cmd.cliFlags || {});
  if (shorts.length) parts.push('[' + shorts.map((s) => '--' + s).join('|') + ']');
  for (const [k, spec] of Object.entries(cmd.args)) {
    if ((cmd.positional || []).includes(k) || (cmd.cliFlags && Object.values(cmd.cliFlags).some(([a]) => a === k))) continue;
    parts.push(spec.type === 'boolean' ? `[--${k}]` : `[--${k} <${spec.type === 'integer' ? 'n' : k}>]`);
  }
  return parts.join(' ');
}

export function usage(commands: readonly Command[]): string {
  const rows = commands.filter((c) => c.cli).map((c) => [cliSignature(c), c.summary]);
  const w = Math.min(52, Math.max(...rows.map(([s]) => s.length)));
  return [
    'Usage: ordinate --cli <command> [options]',
    '',
    'Commands:',
    ...rows.map(([s, d]) => '  ' + (s.length > w ? s + '\n  ' + ' '.repeat(w) : s.padEnd(w)) + '  ' + d),
    '',
    'Options:',
    '  --project <id|name>  Run in this project (default: the one opened most recently)',
    '  --json               One JSON document on stdout: {"ok":true,"result":…} or {"ok":false,…}',
    '  --verbose            Print the app\'s own log lines to stderr',
    '  --help               This help, or `help <command>` for one command',
    '',
    'Exit codes: 0 ok, 1 error, 2 usage, 3 not found, 4 automation disabled.',
  ].join('\n');
}

export function commandHelp(cmd: Command): string {
  const lines = ['Usage: ordinate --cli ' + cliSignature(cmd), '', cmd.summary, ''];
  for (const [k, spec] of Object.entries(cmd.args)) lines.push(`  ${k.padEnd(10)} ${spec.description}`);
  if (cmd.project !== false) lines.push(`  ${'project'.padEnd(10)} Project id or exact name (--project).`);
  return lines.join('\n');
}

// ── Text output ──────────────────────────────────────────────────────────────

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 48 ? s.slice(0, 47) + '…' : s;
}

function table(header: string[], rows: unknown[][]): string {
  const cells = rows.map((r) => r.map(cell));
  const w = header.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] || '').length)));
  const line = (r: string[]): string => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd();
  return [line(header), line(w.map((n) => '-'.repeat(n))), ...cells.map(line)].join('\n');
}

function objectTable(list: Record<string, unknown>[]): string {
  const keys: string[] = [];
  for (const o of list) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
  return table(keys, list.map((o) => keys.map((k) => o[k])));
}

const isRow = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Human-readable rendering of any handler result. */
export function formatText(result: unknown): string {
  if (Array.isArray(result)) {
    if (!result.length) return '(none)';
    return result.every(isRow) ? objectTable(result) : result.map(cell).join('\n');
  }
  if (!isRow(result)) return cell(result);
  // A query result: its own columns, then a count line.
  if (Array.isArray(result.columns) && Array.isArray(result.rows) && typeof result.rowCount === 'number') {
    const head = (result.columns as Array<{ name: string }>).map((c) => c.name);
    const n = result.rowCount.toLocaleString('en-US');
    return table(head, result.rows as unknown[][]) + `\n\n${n} row${result.rowCount === 1 ? '' : 's'}${result.truncated ? ' (more exist — raise --limit)' : ''}`;
  }
  const out: string[] = [];
  const nested: string[] = [];
  const w = Math.max(...Object.keys(result).map((k) => k.length));
  for (const [k, v] of Object.entries(result)) {
    if (Array.isArray(v) && v.length && v.every(isRow)) nested.push(`\n${k}:\n${objectTable(v)}`);
    else out.push(`${k.padEnd(w)}  ${Array.isArray(v) ? v.map(cell).join(', ') : cell(v)}`);
  }
  return out.join('\n') + nested.join('\n');
}
