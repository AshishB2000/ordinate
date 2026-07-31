// Local CLI execution adapters — Claude Code ("claude"), Antigravity ("agy"),
// and Codex CLI ("codex"). MAIN PROCESS ONLY. Runs an analyze/follow-up request
// by spawning a locally
// installed CLI in non-interactive print mode and returning the raw assistant
// text, matching the BYOK adapter's { rawText } | { error } shape so it plugs
// into the same downstream envelope parser (src/analyze.js parseReply).
//
// SECURITY (see SECURITY REVIEW in the commit/PR):
//  - The binary executed is ONLY the path captured by Milestone 2 detection
//    (config.getLocalCliResult(id).resolvedPath). Never a bare command name,
//    never a string built from user/AI/config content.
//  - spawn() with an ARGS ARRAY, never shell:true. Prompt text is passed as a
//    single argv element (Claude: stdin; Antigravity: the -p value) — never
//    interpolated into a shell string. The image is a FILE on disk, referenced
//    by path inside the prompt — never interpolated into a flag.
//  - Claude: --tools/--allowedTools "Read" pre-approve only Read; no
//    --dangerously-skip-permissions. Antigravity reads images with NO blanket
//    bypass either (verified: --add-dir + absolute path is enough; we never
//    pass --dangerously-skip-permissions).
//  - Codex: `codex exec` in a read-only sandbox (-s read-only). The image is a
//    NATIVE attachment (-i <abs path>) and the prompt is fed via STDIN, so no
//    user/AI/config text is ever an argv flag value or a shell string. We never
//    pass --dangerously-bypass-approvals-and-sandbox.
//  - cwd is the per-run random temp dir under userData/tmp, removed in a finally
//    block on success/error/timeout, so a CLI's file tools see only that dir.

import * as path from 'path';
import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { app, nativeImage } from 'electron';
import * as config from './config';
import { wrapCommand } from './disclaim';

const TIMEOUT_MS = 90000;      // CLI cold-starts are slower than HTTP.
const MAX_DIMENSION = 1568;    // Claude's largest useful image edge; downscale beyond this.
const MAX_FILE_BYTES = 2 * 1024 * 1024; // Keep the written image under ~2MB.

// Antigravity print-mode tuning. agy's --print-timeout is its own internal cap;
// the runChild SIGKILL backstop sits just above it so a hung child still dies.
// agy runs a full agent loop (plan → Read tool → respond) for image analysis,
// which is much slower than an HTTP call — hence the generous cap.
const AGY_PRINT_TIMEOUT = '110s';
const AGY_HARD_TIMEOUT_MS = 125000;
const AGY_MODELS_TIMEOUT_MS = 15000;
// --sandbox adds terminal restrictions (defence-in-depth). Left OFF: it could
// not be confirmed to preserve the verified --add-dir image read in testing, and
// the spec says enable it ONLY if it doesn't break that flow. Image reading
// already works without any --dangerously-skip-permissions bypass.
const AGY_USE_SANDBOX = false;

// Codex `exec` runs a reasoning agent loop, so (like agy) it is slower than an
// HTTP call — give the SIGKILL backstop a generous cap above a cold start.
const CODEX_HARD_TIMEOUT_MS = 125000;

// Grok is also an agent CLI (cold start + model call) — same generous backstop.
const GROK_HARD_TIMEOUT_MS = 125000;

// OpenCode (agent loop, BYOK model) — same generous backstop.
const OPENCODE_HARD_TIMEOUT_MS = 125000;

// Cursor Agent (cold start + model call; some reports of -p hanging) — generous
// cap so a stuck run fails cleanly instead of spinning forever.
const CURSOR_HARD_TIMEOUT_MS = 125000;

// One turn of the neutral thread (text plus an optional base64 capture).
interface CliMessage { role?: string; text?: string; image?: string }

// ── Typed errors (same shape as src/analyze.js — plain objects, no import) ──
// Parameterised by CLI display name + a sign-in hint so each adapter reports
// itself honestly while keeping one consistent error vocabulary.
interface CliError { ok: false; errorType: string; message: string }
type CliRunResult = { rawText: string } | { error: CliError };

function errAuth(name: string, hint: string): CliError { return { ok: false, errorType: 'auth', message: `${name} ${hint}` }; }
function errRateLimit(): CliError { return { ok: false, errorType: 'rate_limit', message: 'Too many requests — wait a moment and try again.' }; }
function errTimeout(name: string): CliError { return { ok: false, errorType: 'network', message: `${name} took too long to respond. Try again.` }; }
function errProvider(name: string, message?: string): CliError { return { ok: false, errorType: 'provider', message: message || `${name} had an error. Try again.` }; }
function errBadReply(name: string): CliError { return { ok: false, errorType: 'bad_reply', message: `Couldn't read ${name}'s response. Try again.` }; }

const AUTH_RE = /unauthor|api key|not logged in|log ?in|authenticat|invalid.*key|credential|sign ?in/;
// True when output looks like a sign-in/key problem (vs a real crash) — used by the
// model listers to mark an empty result as "not connected yet" rather than a failure.
function isAuthErr(s: string | null | undefined): boolean { return AUTH_RE.test(String(s || '').toLowerCase()); }

function classifyStderr(name: string, hint: string, stderr: string | null | undefined): CliError {
  const s = (stderr || '').toLowerCase();
  if (isAuthErr(s)) return errAuth(name, hint);
  if (/rate.?limit|\b429\b|too many requests|overloaded|quota|resource.?exhausted/.test(s)) return errRateLimit();
  return errProvider(name);
}

// Strip ANSI colour codes a CLI may emit on non-TTY stdout.
function stripAnsi(s: string | null | undefined): string { return (s || '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, ''); }

// Normalize a CLI's raw stdout/stderr into clean text for parsing. This is the
// fix for "works on Mac, fails on Windows": Windows emits CRLF (and tools often
// prepend a UTF-8 BOM), which corrupts JSON.parse (a leading BOM throws) and the
// envelope/line splitting. Order matters: drop the BOM, fold CRLF / lone CR to
// LF, strip ANSI, then trim. All of these are no-ops on already-clean Mac output,
// so the working macOS path is unaffected.
function cleanCliOutput(s: string | null | undefined): string {
  return stripAnsi(
    String(s || '')
      .replace(/^﻿/, '')   // leading UTF-8 BOM (Windows tools love these)
      .replace(/\r\n?/g, '\n')  // CRLF and lone CR → LF
  ).trim();
}

// One-line, length-capped, escape-revealing dump of raw CLI output so a Windows
// vs Mac diff is visible in the logs (shows \r, BOM, hidden control bytes).
function debugRaw(tag: string, raw: string | null | undefined): void {
  const s = String(raw || '');
  const preview = JSON.stringify(s.length > 600 ? s.slice(0, 600) + '…' : s);
  console.error(`[localCliRun] ${tag} raw stdout (${s.length} bytes): ${preview}`);
}

// Downscale + re-encode the capture so the CLI doesn't choke on huge images.
// Cap longest edge at 1568 (Claude's max useful size); fall back to JPEG q80
// only if PNG still exceeds 2MB.
function encodeImage(base64: string): { buf: Buffer; ext: string } {
  let img = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
  const { width, height } = img.getSize();
  const longest = Math.max(width, height);
  if (longest > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / longest;
    img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' });
  }
  let buf = img.toPNG();
  let ext = 'png';
  if (buf.length > MAX_FILE_BYTES) { buf = img.toJPEG(80); ext = 'jpg'; }
  return { buf, ext };
}

// Flatten the neutral thread into one prompt string for a single-shot run.
// `imageRef` (when given) is the on-disk location the model should Read; pass a
// relative path for Claude (cwd-scoped) or an absolute path for Antigravity.
function buildPrompt(messages: CliMessage[], imageRef: string | null): string {
  const turns = messages.map((m) => {
    let text = m.text || '';
    if (m.image && imageRef) {
      text += `\n\n[The screenshot for this request is saved at ${imageRef}. Use your Read tool to open that image file before answering.]`;
    }
    if (messages.length === 1) return text;
    return `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${text}`;
  });
  return turns.join('\n\n---\n\n');
}

// Live agent children, so a timeout OR app quit can kill the whole process
// GROUP (see killTree). detached children would otherwise orphan any background
// daemon the CLI forked.
const liveChildren = new Set<ChildProcess>();

// Kill the child's entire process group. Because we spawn detached, the child is
// its own group leader (pgid === pid), so process.kill(-pid) reaps it AND any
// grandchild it forked — not just the leader.
// ponytail: POSIX group-kill; on Windows process.kill(-pid) throws, so we fall
// back to a leader-only kill (macOS-first app; acceptable on win32).
function killTree(child: ChildProcess | null | undefined, signal: NodeJS.Signals) {
  if (!child || child.pid == null) return;
  try { process.kill(-child.pid, signal); }
  catch (_) { try { child.kill(signal); } catch (_) {} }
}

// Kill every still-running agent child. Called from main.js on app will-quit so a
// test/analysis in flight can't leak an orphaned agent process.
export function killAllRunning(): void {
  for (const child of liveChildren) killTree(child, 'SIGKILL');
  liveChildren.clear();
}

// What one CLI run produced. spawnError set when the process never started;
// otherwise code/stdout/stderr/timedOut describe the completed child.
interface ChildResult {
  spawnError?: boolean;
  code?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

function runChild(bin: string, args: string[], cwd: string, stdin?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv): Promise<ChildResult> {
  return new Promise((resolve) => {
    let child!: ChildProcess;
    try {
      // TCC: run the agent via disclaim-exec (packaged macOS) so it's its OWN
      // responsible process — macOS then blames the AGENT, not Screenchart, for
      // its file access, killing the spurious Photos/Documents/Downloads/Music
      // prompts. No-op passthrough in dev / non-mac. The helper uses SETEXEC, so
      // everything below (pipes, timeout, group-kill) still targets the real agent.
      const { cmd, args: cmdArgs } = wrapCommand(bin, args);
      // detached: true keeps the child its own process-group leader so killTree can
      // reap it (and any daemon it forks). env still inherits process.env: the
      // agents need the real $HOME (~/.claude, ~/.codex, ~/.cursor, …) to auth.
      child = spawn(cmd, cmdArgs, { cwd, windowsHide: true, detached: true, env: env || process.env });
    } catch (err: any) {
      resolve({ spawnError: true, stderr: String((err && err.message) || err) });
      return;
    }
    liveChildren.add(child);
    const done = (result: ChildResult) => { liveChildren.delete(child); resolve(result); };
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child, 'SIGKILL'); }, timeoutMs || TIMEOUT_MS);
    child.stdout!.on('data', (d) => { stdout += d; });
    child.stderr!.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ spawnError: true, stderr: String((err && err.message) || err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut });
    });
    child.stdin!.on('error', () => {}); // ignore EPIPE if the child exits early
    child.stdin!.write(stdin || '');
    child.stdin!.end();
  });
}

// ── JSON-envelope extraction (single step before the SHARED parseReply) ──────
// A CLI's print output may wrap our JSON envelope in markdown fences or banners
// (e.g. an `[image.png](file://…)` link). Pull the envelope out so the EXISTING
// parser sees clean JSON. Returns the envelope string, or the trimmed text when
// no JSON object is found (so connectivity-test "OK" replies pass through too).
function tryParse(s: string): boolean { try { JSON.parse(s); return true; } catch (_) { return false; } }

function balancedObjectFrom(text: string, start: number): string | null {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

function extractEnvelope(text: string): string {
  const t = cleanCliOutput(text);
  // 1. fenced ```json … ``` block.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { const c = fence[1].trim(); if (tryParse(c)) return c; }
  // 2. first balanced {…} that parses as JSON.
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== '{') continue;
    const cand = balancedObjectFrom(t, i);
    if (cand && tryParse(cand)) return cand;
  }
  return t; // no JSON — hand back cleaned text (errors / test replies).
}

// ── Claude Code adapter (Milestone 3 — unchanged behaviour) ──────────────────
const CLAUDE_NAME = 'Claude Code';
const CLAUDE_HINT = 'needs sign-in — run `claude` once, then test again.';

async function runClaude(systemPrompt: string, messages: CliMessage[]): Promise<CliRunResult> {
  const rec = config.getLocalCliResult('claude');
  const bin = rec && rec.status === 'installed' && rec.resolvedPath;
  if (!bin) return { error: errProvider(CLAUDE_NAME, 'Claude Code not detected — rescan in Execution mode.') };

  const dir = path.join(app.getPath('userData'), 'tmp', crypto.randomBytes(8).toString('hex'));
  try {
    await fsp.mkdir(dir, { recursive: true });

    let imageRel: string | null = null;
    const withImage = messages.find((m) => m && m.image);
    if (withImage) {
      const { buf, ext } = encodeImage(withImage.image!);
      imageRel = crypto.randomBytes(6).toString('hex') + '.' + ext;
      await fsp.writeFile(path.join(dir, imageRel), buf);
    }

    const prompt = buildPrompt(messages, imageRel ? `./${imageRel} in your current directory` : null);
    // Curated, user-selected model (see CLAUDE_MODELS); empty → omit --model and
    // use the CLI's own configured model. A bad value surfaces as a normal
    // provider/bad_reply error from the spawn below — not swallowed.
    const model = config.getLocalCliModel('claude');
    const args = [
      '-p',
      '--output-format', 'json',
      '--tools', 'Read',
      '--allowedTools', 'Read',
      '--no-session-persistence',
      '--append-system-prompt', systemPrompt,
    ];
    if (model) args.push('--model', model);

    const out = await runChild(bin, args, dir, prompt);

    if (out.spawnError) return { error: errProvider(CLAUDE_NAME, 'Claude Code not detected — rescan in Execution mode.') };
    if (out.timedOut) return { error: errTimeout(CLAUDE_NAME) };

    let envelope; // ponytail: the CLI's JSON envelope stays untyped (any)
    try {
      // cleanCliOutput strips a BOM + folds CRLF→LF so JSON.parse doesn't choke
      // on Windows output (a leading BOM alone makes JSON.parse throw).
      envelope = JSON.parse(cleanCliOutput(out.stdout));
    } catch (_) {
      debugRaw('claude', out.stdout);
      if (out.code !== 0) return { error: classifyStderr(CLAUDE_NAME, CLAUDE_HINT, out.stderr) };
      return { error: errBadReply(CLAUDE_NAME) };
    }

    if (out.code !== 0 || envelope.is_error || envelope.subtype !== 'success') {
      return { error: classifyStderr(CLAUDE_NAME, CLAUDE_HINT, out.stderr || envelope.result || '') };
    }
    if (Array.isArray(envelope.permission_denials) && envelope.permission_denials.length) {
      return { error: errProvider(CLAUDE_NAME, 'Claude Code was blocked from reading the screenshot.') };
    }
    return { rawText: String(envelope.result || '') };
  } catch (err: any) {
    console.error('[localCliRun] claude error:', err && err.message);
    return { error: errProvider(CLAUDE_NAME) };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Antigravity CLI adapter (M3 pattern, agy's verified flags) ───────────────
// Print mode: `agy [--sandbox] [--add-dir <dir>] [--model <m>] --print-timeout
// <dur> -p "<prompt>"`. agy has no system-prompt flag, so the shared envelope
// system prompt is prepended to the prompt text. Image read works with --add-dir
// + an ABSOLUTE path in the prompt — NO --dangerously-skip-permissions.
const AGY_NAME = 'Antigravity (Google)';
const AGY_HINT = 'needs sign-in — run `agy` once, then test again.';

async function runAntigravity(systemPrompt: string, messages: CliMessage[]): Promise<CliRunResult> {
  const rec = config.getLocalCliResult('antigravity');
  const bin = rec && rec.status === 'installed' && rec.resolvedPath;
  if (!bin) return { error: errProvider(AGY_NAME, 'Antigravity (Google) not detected — rescan in Execution mode.') };

  const dir = path.join(app.getPath('userData'), 'tmp', crypto.randomBytes(8).toString('hex'));
  try {
    await fsp.mkdir(dir, { recursive: true });

    let imageAbs: string | null = null;
    const withImage = messages.find((m) => m && m.image);
    if (withImage) {
      const { buf, ext } = encodeImage(withImage.image!);
      imageAbs = path.join(dir, crypto.randomBytes(6).toString('hex') + '.' + ext);
      await fsp.writeFile(imageAbs, buf);
    }

    const prompt = `${systemPrompt}\n\n${buildPrompt(messages, imageAbs)}`;
    const model = config.getLocalCliModel('antigravity');

    // Args: only fixed literal flags + the detection-resolved path + the user's
    // model from agy's own list. Prompt CONTENT is a single argv element.
    const args: string[] = [];
    if (AGY_USE_SANDBOX) args.push('--sandbox');
    if (imageAbs) args.push('--add-dir', dir);
    if (model) args.push('--model', model);
    args.push('--print-timeout', AGY_PRINT_TIMEOUT, '-p', prompt);

    const out = await runChild(bin, args, dir, '', AGY_HARD_TIMEOUT_MS);

    if (out.spawnError) return { error: errProvider(AGY_NAME, 'Antigravity (Google) not detected — rescan in Execution mode.') };
    if (out.timedOut) return { error: errTimeout(AGY_NAME) };
    if (out.code !== 0) {
      debugRaw('antigravity (exit ' + out.code + ')', out.stdout);
      return { error: classifyStderr(AGY_NAME, AGY_HINT, out.stderr || out.stdout || '') };
    }

    const text = cleanCliOutput(out.stdout);
    if (!text) {
      // Empty after cleaning — log the raw bytes (and stderr) so we can see what
      // agy actually emitted on this platform instead of guessing.
      debugRaw('antigravity (empty after clean)', out.stdout);
      if (out.stderr) debugRaw('antigravity stderr', out.stderr);
      return { error: errBadReply(AGY_NAME) };
    }
    return { rawText: extractEnvelope(text) };
  } catch (err: any) {
    console.error('[localCliRun] antigravity error:', err && err.message);
    return { error: errProvider(AGY_NAME) };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Codex CLI adapter (`codex exec`, non-interactive) ────────────────────────
// `codex exec` runs headlessly (NOT the TUI). Differences from claude/agy:
//  - Image is a NATIVE vision attachment via `-i <abs>` — no "Read this file"
//    prompt hint, so buildPrompt() is called with imageRef=null.
//  - The prompt is fed via STDIN (codex reads it when no positional PROMPT arg
//    is given). This is REQUIRED, not just tidy: `-i, --image <FILE>...` is
//    variadic, so a positional prompt placed after it gets swallowed as a second
//    image path. stdin sidesteps that entirely.
//  - Output: `-o <file>` writes ONLY the agent's final message (clean, no banner
//    or "tokens used" framing), so we read that file instead of scraping stdout.
//  - codex exec has no system-prompt flag, so the shared envelope system prompt
//    is prepended to the prompt text (same as agy).
const CODEX_NAME = 'Codex CLI';
const CODEX_HINT = 'needs sign-in — run `codex` once, then test again.';

async function runCodex(systemPrompt: string, messages: CliMessage[]): Promise<CliRunResult> {
  const rec = config.getLocalCliResult('codex');
  const bin = rec && rec.status === 'installed' && rec.resolvedPath;
  if (!bin) return { error: errProvider(CODEX_NAME, 'Codex CLI not detected — rescan in Execution mode.') };

  const dir = path.join(app.getPath('userData'), 'tmp', crypto.randomBytes(8).toString('hex'));
  const lastMsgFile = path.join(dir, 'codex-last.txt');
  try {
    await fsp.mkdir(dir, { recursive: true });

    let imageAbs: string | null = null;
    const withImage = messages.find((m) => m && m.image);
    if (withImage) {
      const { buf, ext } = encodeImage(withImage.image!);
      imageAbs = path.join(dir, crypto.randomBytes(6).toString('hex') + '.' + ext);
      await fsp.writeFile(imageAbs, buf);
    }

    // imageRef=null: codex attaches the image itself via -i, so the prompt needn't
    // point at a file. systemPrompt prepended (no system-prompt flag).
    const prompt = `${systemPrompt}\n\n${buildPrompt(messages, null)}`;
    const model = config.getLocalCliModel('codex');

    // Fixed literal flags only; the user's model (if any) is from codex's own set.
    // read-only sandbox: analysis writes nothing. skip-git-repo-check: the temp
    // dir isn't a repo. ephemeral: no session files left behind. color never: no
    // ANSI. -C scopes the working root to the temp dir. -o captures the final
    // message. -i attaches the image. The prompt goes via stdin (see header).
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '-s', 'read-only',
      '--color', 'never',
      '-C', dir,
      '-o', lastMsgFile,
    ];
    if (imageAbs) args.push('-i', imageAbs);
    if (model) args.push('-m', model);

    const out = await runChild(bin, args, dir, prompt, CODEX_HARD_TIMEOUT_MS);

    if (out.spawnError) return { error: errProvider(CODEX_NAME, 'Codex CLI not detected — rescan in Execution mode.') };
    if (out.timedOut) return { error: errTimeout(CODEX_NAME) };

    // Prefer the -o last-message file (clean, banner-free); fall back to stdout if
    // it's missing/empty (write failure or an older codex without working -o).
    let text = '';
    try { text = cleanCliOutput(await fsp.readFile(lastMsgFile, 'utf8')); } catch (_) {}
    if (!text) text = cleanCliOutput(out.stdout);

    if (out.code !== 0 && !text) {
      debugRaw('codex (exit ' + out.code + ')', out.stdout);
      return { error: classifyStderr(CODEX_NAME, CODEX_HINT, out.stderr || out.stdout || '') };
    }
    if (!text) {
      debugRaw('codex (empty after clean)', out.stdout);
      if (out.stderr) debugRaw('codex stderr', out.stderr);
      return { error: errBadReply(CODEX_NAME) };
    }
    return { rawText: extractEnvelope(text) };
  } catch (err: any) {
    console.error('[localCliRun] codex error:', err && err.message);
    return { error: errProvider(CODEX_NAME) };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Grok CLI adapter (superagent-ai/grok-cli, `grok -p`) ─────────────────────
// Differences from codex/claude/agy:
//  - Image: Grok has NO image flag. Its headless message builder scans the PROMPT
//    TEXT for an absolute path ending in .png/.jpg/.jpeg and auto-attaches the
//    bytes as a vision part (default model grok-4.3 is vision-capable). So we
//    embed the absolute temp-image path in the prompt; the model SEES the image
//    directly (it is not read via a tool). We deliberately do NOT use buildPrompt's
//    "use your Read tool" hint here — with tools disabled (below) that wording
//    would be unfollowable; instead we state the image is attached.
//  - Containment: `--max-tool-rounds 0` disables ALL tool/shell execution, so the
//    model answers purely from the attached image. That is the real safety lever —
//    which is why `--no-sandbox` is acceptable (no shell ever runs) and we avoid
//    grok's external "Shuru" --sandbox, which we cannot assume is installed.
//  - Output: `--format text` (json mode is an event STREAM whose first {…} is a
//    step event, not our envelope). Output carries ANSI, handled by cleanCliOutput.
//  - Auth: an xAI API key via GROK_API_KEY (or grok's own ~/.grok/user-settings.json).
//    We pass the app env through so a GROK_API_KEY in the environment reaches grok.
const GROK_NAME = 'Grok CLI';
const GROK_HINT = 'needs an xAI API key — set GROK_API_KEY, then test again.';

async function runGrok(systemPrompt: string, messages: CliMessage[]): Promise<CliRunResult> {
  const rec = config.getLocalCliResult('grok');
  const bin = rec && rec.status === 'installed' && rec.resolvedPath;
  if (!bin) return { error: errProvider(GROK_NAME, 'Grok CLI not detected — rescan in Execution mode.') };

  const dir = path.join(app.getPath('userData'), 'tmp', crypto.randomBytes(8).toString('hex'));
  try {
    await fsp.mkdir(dir, { recursive: true });

    let imageAbs: string | null = null;
    const withImage = messages.find((m) => m && m.image);
    if (withImage) {
      const { buf, ext } = encodeImage(withImage.image!);
      imageAbs = path.join(dir, crypto.randomBytes(6).toString('hex') + '.' + ext);
      await fsp.writeFile(imageAbs, buf);
    }

    // imageRef=null: build the conversation WITHOUT the Read-tool hint, then state
    // the image is attached and embed its absolute path so grok auto-attaches it.
    let prompt = `${systemPrompt}\n\n${buildPrompt(messages, null)}`;
    if (imageAbs) prompt += `\n\nThe screenshot to analyze is attached (located at ${imageAbs}).`;
    const model = config.getLocalCliModel('grok');

    // Fixed literal flags only; the user's model (if any) is from grok's own set.
    const args = [
      '-p', prompt,
      '--format', 'text',
      '--no-sandbox',
      '--max-tool-rounds', '0',
      '-d', dir,
    ];
    if (model) args.push('-m', model);

    // Pass the app env so a GROK_API_KEY in the environment reaches grok.
    const out = await runChild(bin, args, dir, '', GROK_HARD_TIMEOUT_MS, process.env);

    if (out.spawnError) return { error: errProvider(GROK_NAME, 'Grok CLI not detected — rescan in Execution mode.') };
    if (out.timedOut) return { error: errTimeout(GROK_NAME) };
    if (out.code !== 0) {
      debugRaw('grok (exit ' + out.code + ')', out.stdout);
      return { error: classifyStderr(GROK_NAME, GROK_HINT, out.stderr || out.stdout || '') };
    }

    const text = cleanCliOutput(out.stdout);
    if (!text) {
      debugRaw('grok (empty after clean)', out.stdout);
      if (out.stderr) debugRaw('grok stderr', out.stderr);
      return { error: errBadReply(GROK_NAME) };
    }
    return { rawText: extractEnvelope(text) };
  } catch (err: any) {
    console.error('[localCliRun] grok error:', err && err.message);
    return { error: errProvider(GROK_NAME) };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── OpenCode adapter (anomalyco/opencode, `opencode run`) ────────────────────
// OpenCode is a BYOK, model-agnostic agent. Notes:
//  - Headless: `opencode run "<prompt>"` (message is POSITIONAL). Image via
//    `-f <abs>`; because -f is a yargs ARRAY option, the prompt must come FIRST or
//    -f swallows it as a second file (verified: "File not found: <prompt>").
//  - Vision depends on the configured provider/model. The default free models
//    (opencode/*) are NOT vision-capable — an image run hangs or errors. So this
//    adapter DETECTS when the model didn't actually analyze the image and returns
//    a CLEAR message to configure a vision-capable provider, rather than silently
//    passing a broken/empty result downstream.
//  - Output: --format default (the default) prints a "> agent · title" header
//    before the answer (ANSI), which cleanCliOutput + extractEnvelope skip to our
//    JSON envelope. (json mode is a raw event stream, unsuitable for extractEnvelope.)
//  - Auth: BYOK via `opencode auth login` or provider env keys. --dir scopes file
//    ops to the temp dir, --pure disables external plugins; we never pass
//    --dangerously-skip-permissions.
const OPENCODE_NAME = 'OpenCode';
const OPENCODE_HINT = 'needs a provider — run `opencode auth login`, then test again.';

// Output signals that the model couldn't actually see the attached image.
function opencodeImageMiss(s: string | null | undefined): boolean {
  return /does ?n[o']?t support image|not support image input|no image (was )?(provided|attached|found|given)|cannot (see|view|read|process) (the |any )?image|unable to [^.]{0,30}image/i.test(s || '');
}

async function runOpenCode(systemPrompt: string, messages: CliMessage[]): Promise<CliRunResult> {
  const rec = config.getLocalCliResult('opencode');
  const bin = rec && rec.status === 'installed' && rec.resolvedPath;
  if (!bin) return { error: errProvider(OPENCODE_NAME, 'OpenCode not detected — rescan in Execution mode.') };

  const dir = path.join(app.getPath('userData'), 'tmp', crypto.randomBytes(8).toString('hex'));
  try {
    await fsp.mkdir(dir, { recursive: true });

    let imageAbs: string | null = null;
    const withImage = messages.find((m) => m && m.image);
    if (withImage) {
      const { buf, ext } = encodeImage(withImage.image!);
      imageAbs = path.join(dir, crypto.randomBytes(6).toString('hex') + '.' + ext);
      await fsp.writeFile(imageAbs, buf);
    }

    // imageRef=null: the image is delivered via -f, not a path in the prompt.
    // systemPrompt prepended (opencode has no system-prompt flag).
    const prompt = `${systemPrompt}\n\n${buildPrompt(messages, null)}`;
    const model = config.getLocalCliModel('opencode'); // 'provider/model' or ''

    // Message FIRST (positional), then -f LAST so the array flag can't swallow it.
    const args = ['run', prompt, '--pure', '--dir', dir];
    if (model) args.push('-m', model);
    if (imageAbs) args.push('-f', imageAbs);

    const out = await runChild(bin, args, dir, '', OPENCODE_HARD_TIMEOUT_MS);

    if (out.spawnError) return { error: errProvider(OPENCODE_NAME, 'OpenCode not detected — rescan in Execution mode.') };
    if (out.timedOut) {
      // A hang on an image run almost always means a non-vision model stalled.
      return { error: errProvider(OPENCODE_NAME, withImage
        ? 'OpenCode timed out — the screenshot may have stalled a non-vision model. Configure a vision-capable provider/model for OpenCode.'
        : 'OpenCode took too long to respond. Try again.') };
    }
    if (out.code !== 0) {
      debugRaw('opencode (exit ' + out.code + ')', out.stdout);
      const errText = out.stderr || out.stdout || '';
      if (withImage && opencodeImageMiss(errText)) {
        return { error: errProvider(OPENCODE_NAME, 'OpenCode’s model can’t accept images — configure a vision-capable provider/model for OpenCode (e.g. Claude, GPT-4-class, Gemini).') };
      }
      return { error: classifyStderr(OPENCODE_NAME, OPENCODE_HINT, errText) };
    }

    const text = cleanCliOutput(out.stdout);
    if (!text) {
      debugRaw('opencode (empty after clean)', out.stdout);
      if (out.stderr) debugRaw('opencode stderr', out.stderr);
      return { error: errBadReply(OPENCODE_NAME) };
    }

    const envelope = extractEnvelope(text);
    // Image runs: if the model said it couldn't see an image, OR it returned but
    // produced no usable JSON analysis, the screenshot likely never reached the
    // model (a non-vision provider). Surface a CLEAR message, not a broken result.
    if (withImage) {
      if (opencodeImageMiss(text)) {
        return { error: errProvider(OPENCODE_NAME, 'OpenCode ran but its model can’t accept images — configure a vision-capable provider/model for OpenCode (e.g. Claude, GPT-4-class, Gemini).') };
      }
      if (!tryParse(envelope)) {
        return { error: errProvider(OPENCODE_NAME, 'OpenCode ran but didn’t return image analysis — the screenshot may not have reached the model. Check that a vision-capable provider/model is configured for OpenCode.') };
      }
    }
    return { rawText: envelope };
  } catch (err: any) {
    console.error('[localCliRun] opencode error:', err && err.message);
    return { error: errProvider(OPENCODE_NAME) };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Cursor Agent adapter (cursor-agent -p, JSON envelope) ────────────────────
// Cursor's headless --output-format json is claude-shaped:
//   { type:"result", subtype:"success", is_error:false, result:"<assistant text>", ... }
// so we parse it like the claude adapter (JSON.parse → check is_error/subtype →
// extractEnvelope on .result). Other notes:
//  - Image: no flag — embed the absolute image path in the prompt; Cursor reads
//    the referenced image (path-in-prompt, like grok/claude/agy).
//  - Containment: --mode ask is read-only (Q&A; no edits/shell). --trust skips the
//    workspace-trust prompt that can otherwise hang a -p run. A hard timeout backs
//    that up so a stuck run fails cleanly rather than spinning forever.
//  - Auth: an API key via CURSOR_API_KEY (or `cursor-agent login`). We pass the app
//    env through so a CURSOR_API_KEY in the environment reaches cursor-agent.
const CURSOR_NAME = 'Cursor Agent';
const CURSOR_HINT = 'needs an API key — set CURSOR_API_KEY or run `cursor-agent login`, then test again.';

async function runCursor(systemPrompt: string, messages: CliMessage[]): Promise<CliRunResult> {
  const rec = config.getLocalCliResult('cursor');
  const bin = rec && rec.status === 'installed' && rec.resolvedPath;
  if (!bin) return { error: errProvider(CURSOR_NAME, 'Cursor Agent not detected — rescan in Execution mode.') };

  const dir = path.join(app.getPath('userData'), 'tmp', crypto.randomBytes(8).toString('hex'));
  try {
    await fsp.mkdir(dir, { recursive: true });

    let imageAbs: string | null = null;
    const withImage = messages.find((m) => m && m.image);
    if (withImage) {
      const { buf, ext } = encodeImage(withImage.image!);
      imageAbs = path.join(dir, crypto.randomBytes(6).toString('hex') + '.' + ext);
      await fsp.writeFile(imageAbs, buf);
    }

    // imageRef=null: embed the absolute path ourselves (Cursor reads the image the
    // path points to). systemPrompt prepended (no system-prompt flag).
    let prompt = `${systemPrompt}\n\n${buildPrompt(messages, null)}`;
    if (imageAbs) prompt += `\n\nThe screenshot to analyze is the image at ${imageAbs}`;
    const model = config.getLocalCliModel('cursor');

    // Fixed literal flags only; the user's model (if any) is from cursor's own set.
    const args = [
      '-p',
      '--output-format', 'json',
      '--mode', 'ask',     // read-only Q&A: no edits/shell
      '--trust',           // skip the workspace-trust prompt (a -p hang cause)
      '--workspace', dir,
    ];
    if (model) args.push('--model', model);
    args.push(prompt);     // prompt positional, LAST

    // Pass the app env so a CURSOR_API_KEY in the environment reaches cursor-agent.
    const out = await runChild(bin, args, dir, '', CURSOR_HARD_TIMEOUT_MS, process.env);

    if (out.spawnError) return { error: errProvider(CURSOR_NAME, 'Cursor Agent not detected — rescan in Execution mode.') };
    if (out.timedOut) return { error: errTimeout(CURSOR_NAME) };

    let envelope; // ponytail: the CLI's JSON envelope stays untyped (any)
    try {
      envelope = JSON.parse(cleanCliOutput(out.stdout));
    } catch (_) {
      // Not JSON → an error (auth failures print a plain-text "Error: …" line).
      debugRaw('cursor', out.stdout);
      const errText = out.stderr || out.stdout || '';
      if (errText.trim()) return { error: classifyStderr(CURSOR_NAME, CURSOR_HINT, errText) };
      return { error: errBadReply(CURSOR_NAME) };
    }
    if (out.code !== 0 || envelope.is_error || envelope.subtype !== 'success') {
      return { error: classifyStderr(CURSOR_NAME, CURSOR_HINT, out.stderr || (typeof envelope.result === 'string' ? envelope.result : '')) };
    }

    const body = extractEnvelope(typeof envelope.result === 'string' ? envelope.result : '');
    // An image run that came back with no usable JSON analysis almost always means
    // the screenshot wasn't read — say so rather than passing a broken result on.
    if (withImage && !tryParse(body)) {
      return { error: errProvider(CURSOR_NAME, 'Cursor ran but didn’t return image analysis — the screenshot may not have been read. Try again, or check the model supports images.') };
    }
    return { rawText: body };
  } catch (err: any) {
    console.error('[localCliRun] cursor error:', err && err.message);
    return { error: errProvider(CURSOR_NAME) };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Why a model list came back empty, so the UI can stay neutral when "Default" is a
// legit choice and only flag a genuine failure: 'failed' (couldn't run / crashed),
// 'auth' (installed but not signed in — Default is fine until connected), 'empty'
// (ran fine, nothing listed). 'not_installed' is returned without running anything.
function emptyListReason(out: ChildResult): 'failed' | 'auth' | 'empty' {
  if (out.spawnError || out.timedOut) return 'failed';
  if (out.code !== 0) return isAuthErr(out.stderr || out.stdout) ? 'auth' : 'failed';
  return 'empty';
}

// Model-list result: never fabricates a list; callers fall back to "Default" on !ok.
interface ModelListResult { ok: boolean; models: string[]; reason?: 'not_installed' | 'failed' | 'auth' | 'empty' }

// List the models `agy models` reports, parsed one-per-line. Runs ONLY the
// detection-resolved agy path with the fixed `models` arg. Returns { ok, models,
// reason? } — never fabricates a list; callers fall back to "Default" on !ok.
export async function listAntigravityModels(): Promise<ModelListResult> {
  const rec = config.getLocalCliResult('antigravity');
  const bin = rec && rec.status === 'installed' && rec.resolvedPath;
  if (!bin) return { ok: false, models: [], reason: 'not_installed' };
  const out = await runChild(bin, ['models'], app.getPath('userData'), '', AGY_MODELS_TIMEOUT_MS);
  if (out.spawnError || out.timedOut || out.code !== 0) return { ok: false, models: [], reason: emptyListReason(out) };
  const models = cleanCliOutput(out.stdout)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return models.length ? { ok: true, models } : { ok: false, models: [], reason: 'empty' };
}

// `grok models` prints a formatted block — "  <id> — <desc>" lines plus indented
// description/aliases lines. It needs NO auth, so Grok's picker populates even when
// unconnected. Parse the id from each "<id> — …" line (em-dash only on id lines).
export async function listGrokModels(): Promise<ModelListResult> {
  const rec = config.getLocalCliResult('grok');
  const bin = rec && rec.status === 'installed' && rec.resolvedPath;
  if (!bin) return { ok: false, models: [], reason: 'not_installed' };
  const out = await runChild(bin, ['models'], app.getPath('userData'), '', AGY_MODELS_TIMEOUT_MS, process.env);
  if (out.spawnError || out.timedOut || out.code !== 0) return { ok: false, models: [], reason: emptyListReason(out) };
  const models = cleanCliOutput(out.stdout)
    .split('\n')
    .map((l) => { const m = l.match(/^\s+(\S+)\s+—/); return m ? m[1] : null; })
    .filter((s): s is string => Boolean(s));
  return models.length ? { ok: true, models } : { ok: false, models: [], reason: 'empty' };
}

// `opencode models` prints one "provider/model" per line (no auth needed; reflects
// the user's configured providers + the free tier). Keep bare-token lines only.
export async function listOpenCodeModels(): Promise<ModelListResult> {
  const rec = config.getLocalCliResult('opencode');
  const bin = rec && rec.status === 'installed' && rec.resolvedPath;
  if (!bin) return { ok: false, models: [], reason: 'not_installed' };
  const out = await runChild(bin, ['models'], app.getPath('userData'), '', AGY_MODELS_TIMEOUT_MS);
  if (out.spawnError || out.timedOut || out.code !== 0) return { ok: false, models: [], reason: emptyListReason(out) };
  const models = cleanCliOutput(out.stdout)
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !/\s/.test(s));   // bare provider/model tokens, no prose/headers
  return models.length ? { ok: true, models } : { ok: false, models: [], reason: 'empty' };
}

// `cursor-agent --list-models` needs auth, so Cursor's picker is empty (graceful
// "Default") until connected. Once signed in it prints an "Available models"
// header followed by "<id> - <Label>" lines (regular hyphen, e.g.
// "gpt-5.2 - GPT-5.2", "composer-2.5-fast - Composer 2.5 Fast (default)"). Take
// the leading id token from each "<id> - …" line; the header has no " - " so it's
// skipped.
export async function listCursorModels(): Promise<ModelListResult> {
  const rec = config.getLocalCliResult('cursor');
  const bin = rec && rec.status === 'installed' && rec.resolvedPath;
  if (!bin) return { ok: false, models: [], reason: 'not_installed' };
  const out = await runChild(bin, ['--list-models'], app.getPath('userData'), '', AGY_MODELS_TIMEOUT_MS, process.env);
  // Cursor's --list-models needs auth, so a non-zero exit here is almost always
  // "not signed in" → 'auth' (Default is legit), not a failure to flag.
  if (out.spawnError || out.timedOut || out.code !== 0) return { ok: false, models: [], reason: emptyListReason(out) };
  const models = cleanCliOutput(out.stdout)
    .split('\n')
    .map((l) => { const m = l.match(/^\s*(\S+)\s+-\s+\S/); return m ? m[1] : null; })
    .filter((s): s is string => Boolean(s));
  return models.length ? { ok: true, models } : { ok: false, models: [], reason: 'empty' };
}

// runLocalCli(cliId, systemPrompt, messages, opts) -> { rawText } | { error }
// Mirrors callProvider() so src/analyze.js can branch on execution mode and feed
// the result through the SAME parseReply() afterward.
export async function runLocalCli(cliId: string, systemPrompt: string, messages: CliMessage[], _opts?: unknown): Promise<CliRunResult> {
  if (cliId === 'claude') return runClaude(systemPrompt, messages);
  if (cliId === 'antigravity') return runAntigravity(systemPrompt, messages);
  if (cliId === 'codex') return runCodex(systemPrompt, messages);
  if (cliId === 'grok') return runGrok(systemPrompt, messages);
  if (cliId === 'opencode') return runOpenCode(systemPrompt, messages);
  if (cliId === 'cursor') return runCursor(systemPrompt, messages);
  return { error: errProvider('That local CLI', 'isn’t supported yet.') };
}
