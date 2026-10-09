// The shared half of scripts/test-warehouseLive.ts (the real-account nightly):
// what it prints, what it keeps for the secret canary, and the spike's record.
// Not a suite itself — test-warehouseLive.ts and its two warehouse modules
// (warehouseLiveSnowflake.ts, warehouseLiveBigquery.ts) import it.
//
// The nightly's log is PUBLIC on an open-source repo, so nothing here prints an
// identifier of the account under test (account, user, project, dataset,
// service-account e-mail, table names) or a secret: `say`, `spike` and a
// failure's detail pass through `redact`. That is presentation only. The
// canary is the raw record — every result and error the connectors returned,
// kept UNREDACTED by `keep` — plus every byte this process printed, grepped for
// every secret the run planted or was issued (`secret`).

import { ok as selfcheckOk } from './selfcheck';

const fs: typeof import('fs') = require('fs');

/** The org the run acts for (its request context): it names the Snowflake QUERY_TAG. */
export const ORG = 'nightly';

// ── Capture every byte this process prints (the canary greps it) ────────────
let captured = '';
for (const s of [process.stdout, process.stderr]) {
  const orig = s.write.bind(s) as (...a: unknown[]) => boolean;
  (s as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    captured += String(chunk);
    return orig(chunk, ...rest);
  };
}

const needles = new Map<string, string>(); // secret value → what it is
const idents = new Map<string, string>(); // identifier → its placeholder
const outputs: string[] = [];
const spikes: [string, string][] = [];
const sections: string[] = [];

/** Every secret and identifier out of `s`, longest first (a token may contain a shorter one). */
export function redact(s: string): string {
  let out = String(s);
  const all = [...[...needles.keys()].map((v) => [v, '***'] as const), ...idents.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [v, r] of all) out = out.split(v).join(r);
  return out;
}

/** A check; its detail is shown only on failure, and redacted. */
export function ok(label: string, cond: boolean, extra?: unknown): void {
  selfcheckOk(label, cond, extra === undefined ? undefined : redact(typeof extra === 'string' ? extra : JSON.stringify(extra) ?? String(extra)));
}

/** A secret the canary must never find: the value, and every line of it long enough to identify it (a PEM's body). */
export function secret(label: string, value: string | undefined | null): void {
  const v = typeof value === 'string' ? value.trim() : '';
  if (v.length < 8) return;
  needles.set(v, label);
  const lines = v.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 16 && !l.startsWith('-----'));
  if (lines.length > 1) {
    lines.forEach((l, i) => needles.set(l, `${label}, line ${i + 1}`));
    needles.set(lines.join(''), `${label}, body`);
  }
  // A JSON key file escapes its PEM's newlines; the escaped body is a spelling too.
  if (v.includes('\n')) needles.set(JSON.stringify(v).slice(1, -1), `${label}, JSON-escaped`);
}

/** An identifier of the account under test: shown as `<label>` in everything printed. `anyCase`
 *  for a Snowflake account or user, which Snowflake prints lower- or upper-cased (its host, its errors). */
export function ident(label: string, value: string | undefined | null, anyCase = false): void {
  const v = typeof value === 'string' ? value.trim() : '';
  if (v.length < 3) return;
  for (const spelling of anyCase ? [v, v.toLowerCase(), v.toUpperCase()] : [v]) idents.set(spelling, `<${label}>`);
}

/** Keep a connector's result (or error) for the canary — unredacted — and hand it back. */
export function keep<T>(v: T): T {
  outputs.push(JSON.stringify(v) ?? String(v));
  const e = (v as { ok?: unknown; error?: unknown } | null)?.error;
  if (typeof e === 'string') outputs.push(e); // raw too: JSON escapes a PEM's newlines
  return v;
}

/** A line for the log (redacted). */
export function say(line: string): void {
  console.log(`     ${redact(line)}`);
}

/** One answer to the read-only scope spike (docs/live-data/log.md), printed and summarised. */
export function spike(question: string, answer: string): void {
  const a = redact(answer).replace(/\s+/g, ' ').slice(0, 300);
  spikes.push([question, a]);
  console.log(`spike: ${question}: ${a}`);
}

/** A line of the run's summary (GitHub's step summary, when there is one). */
export function summary(line: string): void {
  sections.push(line);
}

/** Which secrets `hay` contains, by label. */
export function leaksIn(hay: string): string[] {
  return [...needles].filter(([v]) => hay.includes(v)).map(([, l]) => l);
}

/** The canary's negative control: the grep finds a planted secret in a haystack, and nothing in a clean one. */
export function canaryControl(): boolean {
  const first = [...needles.keys()][0];
  return !!first && leaksIn(`x ${first} y`).length > 0 && leaksIn(`nothing ${Date.now()}`).length === 0;
}

/** The canary over everything kept and printed: [secrets planted, outputs kept, labels of any leak]. */
export function canary(): { planted: number; outputs: number; leaks: string[] } {
  return { planted: needles.size, outputs: outputs.length, leaks: [...new Set(leaksIn(outputs.join('\n') + '\n' + captured))] };
}

/** Append the run's record to $GITHUB_STEP_SUMMARY (the nightly's run page). Redacted like the log. */
export function writeSummary(): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = ['## Warehouse nightly', '', ...sections];
  if (spikes.length) {
    lines.push('', '### BigQuery read-only scope spike', '', '| Question | Answer |', '|---|---|');
    for (const [q, a] of spikes) lines.push(`| ${q.replace(/\|/g, '\\|')} | ${a.replace(/\|/g, '\\|')} |`);
  }
  try {
    fs.appendFileSync(file, redact(lines.join('\n')) + '\n');
  } catch {
    /* the summary is a convenience; the log has every line */
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait for `cond`, checking every `every` ms, at most `ms`. */
export async function until(cond: () => boolean | Promise<boolean>, ms: number, every = 250): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > end) return false;
    await sleep(every);
  }
}

/** A result's error, for a failure's detail. */
export const errOf = (r: unknown): string => {
  const o = r as { ok?: unknown; error?: unknown } | null;
  return o && o.ok === false ? String(o.error) : '';
};
