// Command-line parsing for the headless app — PURE, no Electron.
//
// `headlessMode` is read at the very top of src/main.ts, before the
// single-instance lock, so it must stay dependency-free and cheap. `parseCli`
// turns the words after `--cli` into a registry command and its arguments;
// every malformed input is an AutomationError('usage') → exit code 2.

import { AutomationError } from './errors';
import type { Args, Command } from './registry';

export type HeadlessMode = 'cli' | 'mcp';

/**
 * `--cli` / `--mcp` as a WHOLE argument, before any `--` terminator. The first
 * one wins, so a SQL string that happens to contain "--mcp" after `--cli`
 * never changes the mode.
 */
export function headlessMode(argv: readonly string[]): HeadlessMode | null {
  for (const a of argv) {
    if (a === '--') return null;
    if (a === '--cli') return 'cli';
    if (a === '--mcp') return 'mcp';
  }
  return null;
}

/** The arguments after the mode switch. */
export function modeArgs(argv: readonly string[], mode: HeadlessMode): string[] {
  const i = argv.indexOf('--' + mode);
  return i < 0 ? [] : argv.slice(i + 1);
}

export interface ParsedCli {
  cmd: Command | null;
  args: Args;
  json: boolean;
  verbose: boolean;
  help: boolean;
}

const GLOBAL_BOOLS = new Set(['json', 'verbose', 'help']);

/**
 * `<group> <sub> [positionals] [--flag value | --flag=value | --bool] [-- words]`.
 *
 * Whether a flag takes a value has to be known before the command is (global
 * flags may come first), so it is decided across the whole registry: `project`
 * and every non-boolean argument name take one; `json`, `verbose`, `help` and
 * each command's shorthands (`--pdf`) do not. The registry keeps a name's type
 * the same everywhere, which is what makes that unambiguous.
 */
export function parseCli(argv: readonly string[], commands: readonly Command[]): ParsedCli {
  const valued = new Set<string>(['project']);
  const bools = new Set<string>(GLOBAL_BOOLS);
  for (const c of commands) {
    for (const [k, spec] of Object.entries(c.args)) (spec.type === 'boolean' ? bools : valued).add(k);
    for (const k of Object.keys(c.cliFlags || {})) bools.add(k);
  }

  const words: string[] = [];
  const flags: Array<[string, string | true]> = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { words.push(...argv.slice(i + 1)); break; }
    if (a === '-h') { flags.push(['help', true]); continue; }
    if (!a.startsWith('--') || a.length < 3) { words.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (bools.has(name)) {
      if (eq > 0) throw new AutomationError('usage', `--${name} takes no value.`);
      flags.push([name, true]);
    } else if (valued.has(name)) {
      if (eq > 0) flags.push([name, a.slice(eq + 1)]);
      else if (i + 1 < argv.length) flags.push([name, argv[++i]]);
      else throw new AutomationError('usage', `--${name} needs a value.`);
    } else {
      throw new AutomationError('usage', `Unknown option --${name}.`);
    }
  }

  const out: ParsedCli = { cmd: null, args: {}, json: false, verbose: false, help: false };
  for (const [k] of flags) if (GLOBAL_BOOLS.has(k)) out[k as 'json' | 'verbose' | 'help'] = true;
  if (!words.length || words[0] === 'help') {
    out.help = true;
    if (words[0] === 'help' && words.length > 1) out.cmd = matchCommand(words.slice(1), commands).cmd;
    return out;
  }

  const { cmd, used } = matchCommand(words, commands);
  if (!cmd) throw new AutomationError('usage', `Unknown command "${words.slice(0, 2).join(' ')}". Run --cli help for the list.`);
  out.cmd = cmd;

  for (const [k, v] of flags) {
    if (GLOBAL_BOOLS.has(k)) continue;
    if (k === 'project') {
      if (cmd.project === false) throw new AutomationError('usage', `--project does not apply to "${cmd.cli}".`);
      out.args.project = v;
      continue;
    }
    const short = cmd.cliFlags && cmd.cliFlags[k];
    if (short) {
      const [arg, value] = short;
      if (out.args[arg] !== undefined && out.args[arg] !== value) {
        throw new AutomationError('usage', `Choose one of ${Object.keys(cmd.cliFlags || {}).map((f) => '--' + f).join(', ')}.`);
      }
      out.args[arg] = value;
      continue;
    }
    const spec = cmd.args[k];
    if (!spec) throw new AutomationError('usage', `--${k} is not an option of "${cmd.cli}".`);
    out.args[k] = coerce(k, v, spec.type);
  }

  const rest = words.slice(used);
  const slots = cmd.positional || [];
  if (rest.length > slots.length && !(cmd.rest && slots.length)) {
    throw new AutomationError('usage', `Unexpected argument "${rest[slots.length]}". Quote values that contain spaces.`);
  }
  slots.forEach((name, i) => {
    if (i >= rest.length) return;
    if (out.args[name] !== undefined) throw new AutomationError('usage', `"${name}" was given twice.`);
    // `rest`: the last slot takes the remaining words — an unquoted SQL string.
    const value = cmd.rest && i === slots.length - 1 ? rest.slice(i).join(' ') : rest[i];
    out.args[name] = coerce(name, value, cmd.args[name] ? cmd.args[name].type : 'string');
  });
  return out;
}

function matchCommand(words: readonly string[], commands: readonly Command[]): { cmd: Command | null; used: number } {
  for (const n of [2, 1]) {
    if (words.length < n) continue;
    const key = words.slice(0, n).join(' ');
    const hit = commands.find((c) => c.cli === key);
    if (hit) return { cmd: hit, used: n };
  }
  return { cmd: null, used: 0 };
}

function coerce(name: string, v: string | true, type: string): unknown {
  if (type === 'integer') {
    if (typeof v !== 'string' || !/^-?\d+$/.test(v.trim())) throw new AutomationError('usage', `--${name} must be a whole number.`);
    return Number(v.trim());
  }
  if (type === 'boolean') return v === true || v === 'true';
  return v === true ? '' : v;
}
