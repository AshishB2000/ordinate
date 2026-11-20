// Deep research: the write call's reply, validated and audited — PURE (the number guard is handed in: there is one of it,
// ipc/copilot `guardAnswer`).
//
// The model returns { title, summary, sections: [{ heading, text, steps }], caveats, conclusion }. Here it is made safe:
//   - a cited step must be a DONE step; any other citation is dropped; at most MAX_SECTIONS sections;
//   - every text is cut to a fixed length, one line per paragraph;
//   - THE AUDIT: a section's text against the ledgers of the steps it cites, plus the guidance ledger; the summary and
//     conclusion against every done step. A violation adds the guard's note, as an answer's does. A title or heading is
//     audited the same way (a figure in a name is a figure the model wrote);
//   - caveats hold no figure: one with a figure-like token is dropped.
// And the question-5 rule for "Add to project": `storyBlocks` keeps the prose only where no cited step's data is restricted.

import type { LedgerEntry, NumberAudit } from './numberAudit';
import type { StepRec } from './researchLoop';
import { FIGURE_RE } from '../app/instructions';

export const MAX_SECTIONS = 6;
const CUT = { title: 120, summary: 1200, heading: 120, text: 2000, caveat: 300, conclusion: 1200 } as const;
const MAX_CAVEATS = 8;

export type Guard = (text: string, ledger: LedgerEntry[]) => { text: string; audit: NumberAudit };

export interface Section { heading: string; text: string; steps: number[] }
export interface Report {
  title: string; summary: string; sections: Section[]; caveats: string[]; conclusion: string;
  /** The write call failed or was skipped: charts only, no words of the model's. */
  chartsOnly?: boolean;
  writtenAt: string;
}

/** One line per paragraph, cut to `max`. */
export function tidy(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const paras = raw.replace(/\r/g, '').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return paras.join('\n\n').slice(0, max).trim();
}

/** The JSON object in a write reply (a code fence taken off), or null. */
export function parseWriteReply(raw: string | null | undefined): Record<string, unknown> | null {
  let s = String(raw ?? '').trim();
  const fenced = /```[a-zA-Z]*\s*\n?([\s\S]*?)```/.exec(s);
  if (fenced) s = fenced[1].trim();
  const open = s.indexOf('{');
  const close = s.lastIndexOf('}');
  if (open < 0 || close <= open) return null;
  try {
    const o: unknown = JSON.parse(s.slice(open, close + 1));
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const doneSteps = (steps: readonly StepRec[]): StepRec[] => steps.filter((s) => s.status === 'done');
const ledgerOf = (steps: readonly StepRec[]): LedgerEntry[] => steps.flatMap((s) => s.ledger ?? []);

/** The validated, audited report, or null when the reply holds nothing usable (the caller then writes charts only). */
export function buildReport(raw: Record<string, unknown> | null, steps: readonly StepRec[], guidance: LedgerEntry[], guard: Guard, writtenAt: string): Report | null {
  if (!raw) return null;
  const done = doneSteps(steps);
  const doneN = new Set(done.map((s) => s.n));
  const all = ledgerOf(done).concat(guidance);
  const audited = (text: string, ledger: LedgerEntry[]): string => (text ? guard(text, ledger).text : '');
  const sections: Section[] = [];
  for (const s of Array.isArray(raw.sections) ? raw.sections : []) {
    if (sections.length >= MAX_SECTIONS) break;
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const cited = [...new Set((Array.isArray(o.steps) ? o.steps : []).filter((n): n is number => typeof n === 'number' && doneN.has(n)))];
    const text = tidy(o.text, CUT.text);
    const heading = tidy(o.heading, CUT.heading).replace(/\n+/g, ' ');
    if (!text && !cited.length) continue;
    const mine = ledgerOf(done.filter((d) => cited.includes(d.n))).concat(guidance);
    sections.push({ heading: audited(heading, mine) || '', text: audited(text, mine), steps: cited });
  }
  const caveats = (Array.isArray(raw.caveats) ? raw.caveats : []).map((c) => tidy(c, CUT.caveat).replace(/\n+/g, ' ')).filter((c) => c && !FIGURE_RE.test(c) && !/\d{3,}/.test(c)).slice(0, MAX_CAVEATS);
  const title = audited(tidy(raw.title, CUT.title).replace(/\n+/g, ' '), all);
  const summary = audited(tidy(raw.summary, CUT.summary), all);
  const conclusion = audited(tidy(raw.conclusion, CUT.conclusion), all);
  if (!sections.length && !summary && !conclusion) return null;
  return { title, summary, sections, caveats, conclusion, writtenAt };
}

/** A report with no words of the model's: one section per done step, the steps' own titles. */
export function chartsOnly(steps: readonly StepRec[], title: string, writtenAt: string): Report {
  return { title: tidy(title, CUT.title).replace(/\n+/g, ' '), summary: '', sections: doneSteps(steps).slice(0, MAX_SECTIONS).map((s) => ({ heading: tidy(s.title, CUT.heading).replace(/\n+/g, ' '), text: '', steps: [s.n] })), caveats: [], conclusion: '', chartsOnly: true, writtenAt };
}

/** What a browser may read of a step: never its facts or its ledger. */
export function publicStep(s: StepRec): Omit<StepRec, 'facts' | 'ledger' | 'datasetIds'> {
  const { facts: _f, ledger: _l, datasetIds: _d, ...rest } = s;
  return rest;
}

// ── "Add to project": the question-5 rule ───────────────────────────────────────────────────────────────────────────

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'visual'; stepN: number }
  | { kind: 'callout'; tone: 'warning'; text: string }
  | { kind: 'divider' };

export interface Words {
  /** A fixed sentence: the full text is in the starter's private report. No model text, no digit. */
  fixed: string;
  /** "Written on <date> from the data then" (the date formatted by the app). */
  written: string;
}

/**
 * The Story's blocks, in order: the summary; per section its heading, its charts and its prose; the caveats as a warning
 * callout; a divider; the conclusion. `restricted`: whether the cited steps' data is restricted (`src/server/slack/check.ts`
 * `restricted()`): per section by index, and over every cited step for the summary and conclusion. A restricted part keeps
 * no model text, only the fixed line. Every section carries its "Written on" line.
 */
export function storyBlocks(report: Report, restricted: { sections: boolean[]; all: boolean }, words: Words, charted: ReadonlySet<number>, extraCaveats: string[] = []): Block[] {
  const out: Block[] = [];
  const prose = (text: string, closed: boolean): void => {
    if (closed) out.push({ kind: 'text', text: words.fixed });
    else if (text) out.push({ kind: 'text', text });
  };
  if (report.title) out.push({ kind: 'text', text: `# ${report.title}` });
  if (report.summary) prose(report.summary, restricted.all);
  report.sections.forEach((s, i) => {
    if (s.heading) out.push({ kind: 'text', text: `## ${s.heading}` });
    for (const n of s.steps) if (charted.has(n)) out.push({ kind: 'visual', stepN: n });
    if (s.text) prose(s.text, restricted.sections[i] ?? true);
    out.push({ kind: 'text', text: words.written });
  });
  const caveats = report.caveats.concat(extraCaveats);
  if (caveats.length) out.push({ kind: 'callout', tone: 'warning', text: caveats.map((c) => `- ${c}`).join('\n') });
  out.push({ kind: 'divider' });
  if (report.conclusion) prose(report.conclusion, restricted.all);
  return out;
}
