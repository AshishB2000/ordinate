// The data issues board's SIGNALS (docs/issues-board/00-design.md) — PURE: no database, no model, no engine.
//
// A signal is one place the Assistant struggled, read off a conversation as it is STORED: a refusal and why (turn body `needs`, #7's
// `define`, a "Did you mean"), an out-of-scope reply (`outside`), a figure the number audit could not trace (its note in the turn
// text: only the MARKER is tested, the figures after it are never copied), a question asked again within a minute in other words.
// A thumbs-down is a signal too, built from its `assistant_feedback` row (`fromThumb`).
//
// What a signal keeps: the asker's own QUESTION words, who asked (the board only counts people), the datasets and dashboards the answer
// showed (so the board can apply the folder rule), and a short name of the cause. Never a word of the answer, a figure or a row.

import { shows } from '../ipc/turnsOpen';
import type { CopilotTurn } from './copilot';
import { GUARD_NOTE } from './numberAuditNote';

export const SIGNAL_KINDS = ['needs_link', 'needs_copy', 'undefined_name', 'refused', 'outside', 'untraced', 'thumbs_down', 'asked_again'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export interface Signal {
  /** The assistant turn that struggled (the thumbs-down's turn, the answer to the first of two asks). */
  turnId: string;
  kind: SignalKind;
  /** A thumbs-down's reason code. */
  reason: string | null;
  /** The cause, when the signal names one: groups by it. Null: groups by question words. */
  key: string | null;
  /** The missing name or dataset the cause is about, for the model and the fallback title. One line, at most 80 characters. */
  label: string | null;
  question: string;
  owner: string;
  datasetIds: string[];
  dashboardIds: string[];
  /** ISO time of the turn. */
  at: string;
}

/** One line of at most `max` characters, as a name or a question is shown. */
export const oneLine = (s: string, max: number): string => s.replace(/\s+/g, ' ').trim().slice(0, max);
/** A name compared: case, accents' marks and punctuation do not tell two names apart. */
export const norm = (s: string): string => s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const STOP = new Set(('the and for are was were what which who whom how why when where does did has have had with from that this these those into over under about than then them they their there here you your our ours can could would should will shall may might not but any all per each its it is be been being by on in of to as at or an a show give tell list get see number total count many much last').split(' '));

/** The content words of a question: letters only, three or more, no stop word, no digit, once each. */
export function wordsOf(q: string): string[] {
  const out = new Set<string>();
  for (const w of norm(q).split(' ')) if (w.length >= 3 && !STOP.has(w) && !/\p{N}/u.test(w)) out.add(w);
  return [...out];
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const set = new Set(a);
  let both = 0;
  for (const w of new Set(b)) if (set.has(w)) both += 1;
  return both / (set.size + new Set(b).size - both);
}

/** Two asks in one conversation this close in time, in other words, are one need asked again. */
export const ASKED_AGAIN_MS = 60_000;
/** Asked again: at least this share of content words in common, and not the same words. */
export const ASKED_AGAIN_SIMILAR = 0.5;

const LABEL_MAX = 80;
/** A label is words only: one with a digit is left out, as it could carry a figure. */
const labelOf = (s: string | undefined | null): string | null => {
  const one = s ? oneLine(s, LABEL_MAX) : '';
  return one && !/\d/.test(one) ? one : null;
};

/** The signals one stored turn carries, with the question before it. `ask` is that question's turn. */
function ofTurn(t: CopilotTurn, ask: CopilotTurn, owner: string): Signal[] {
  if (t.role !== 'assistant' || t.research) return [];
  const base = { turnId: t.id, reason: null, question: ask.text, owner, datasetIds: [...new Set(shows(t))], dashboardIds: t.dashboardsFrom ?? [], at: t.createdAt };
  const out: Signal[] = [];
  if (t.needs === 'link') {
    const names = t.link ? [t.link.from.dataset, t.link.to.dataset] : [];
    out.push({ ...base, kind: 'needs_link', reason: 'link', key: names.length ? `link:${names.map(norm).sort().join('|')}` : null, label: labelOf(names.join(' and ')) });
  } else if (t.needs === 'copy') {
    out.push({ ...base, kind: 'needs_copy', reason: 'copy', key: base.datasetIds[0] ? `copy:${base.datasetIds[0]}` : null, label: null });
  } else if (t.define) {
    const said = labelOf(t.suggest?.said);
    out.push({ ...base, kind: 'undefined_name', key: said ? `name:${norm(said)}` : null, label: said });
  } else if (t.suggest) {
    const said = labelOf(t.suggest.said);
    out.push({ ...base, kind: 'refused', key: said ? `miss:${t.suggest.part}:${norm(said)}` : null, label: said });
  }
  if (t.outside) {
    const ds = labelOf(t.outside.dataset);
    out.push({ ...base, kind: 'outside', key: ds ? `outside:${norm(ds)}` : null, label: ds });
  }
  if (t.text.includes(GUARD_NOTE)) out.push({ ...base, kind: 'untraced', key: null, label: null });
  return out;
}

/**
 * The signals of one conversation's turns, in order. `owner` is who asked. A question is the user turn nearest before the assistant turn;
 * an assistant turn with none carries no signal (there is nothing to show).
 */
export function signalsOfThread(owner: string, turns: readonly CopilotTurn[]): Signal[] {
  const out: Signal[] = [];
  let ask: CopilotTurn | null = null;
  let prevAsk: CopilotTurn | null = null;
  let prevAnswer: CopilotTurn | null = null;
  for (const t of turns) {
    if (t.role === 'user') {
      if (t.text.trim()) {
        // The previous question, answered, and this one within a minute in other words: the first one struggled.
        const gap = prevAsk ? Date.parse(t.createdAt) - Date.parse(prevAsk.createdAt) : NaN;
        if (prevAsk && prevAnswer && gap >= 0 && gap <= ASKED_AGAIN_MS && norm(prevAsk.text) !== norm(t.text) && jaccard(wordsOf(prevAsk.text), wordsOf(t.text)) >= ASKED_AGAIN_SIMILAR && !prevAnswer.research) {
          out.push({
            turnId: prevAnswer.id, kind: 'asked_again', reason: null, key: null, label: null, question: prevAsk.text, owner,
            datasetIds: [...new Set(shows(prevAnswer))], dashboardIds: prevAnswer.dashboardsFrom ?? [], at: prevAnswer.createdAt,
          });
        }
        ask = t;
        prevAsk = t;
        prevAnswer = null;
      }
      continue;
    }
    if (ask) {
      out.push(...ofTurn(t, ask, owner));
      prevAnswer ??= t; // the first answer to this question
    }
  }
  return out;
}

/** A thumbs-down row of `assistant_feedback` as a signal. */
export function fromThumb(r: { turnId: string; owner: string; question: string; reason: string | null; datasetIds: string[]; dashboardIds: string[]; at: string }): Signal {
  return { turnId: r.turnId, kind: 'thumbs_down', reason: r.reason, key: null, label: null, question: r.question, owner: r.owner, datasetIds: r.datasetIds, dashboardIds: r.dashboardIds, at: r.at };
}
