// The agent router's scorer and its decision — PURE: no fs, no database, no model (docs/agent-router/00-design.md).
//
// Given the question and the agents a person MAY USE (the caller filters with `mayUse`; this file never sees another),
// each agent scores by how well the question's words match what it answers from:
//
//   its data       the Assistant's search results (../ipc/assistantSearch, ONE query for the whole project) on the datasets
//                  of its topic, a column only when the topic keeps that field, a metric or term also when the topic names it.
//                  A hit found by meaning alone (fingerprints, score 0) counts 1. A name shows only once.
//   verified       2 per question word in a verified question on its topic's datasets
//   documents      2 per question word in the title of one of its knowledge documents
//   description    1 per question word in its description
//
// An agent with no topic answers from all data: it gets no data or verified points (they would make it win every time),
// only its description and documents.
//
// `decide`: nothing to compare (best under MIN_SCORE), a clear winner (best at least 1.5x the second), or a close call. The
// reason shown with an answer (`whyOf`) comes from the matches only, in the app's sentences.

import { searchWords } from './modelWords';
import * as msg from './agentRouteMessages';

export type MatchKind = 'dataset' | 'column' | 'metric' | 'term' | 'verified' | 'document' | 'description';

/** A result of the Assistant's search of the Data model (../ipc/assistantSearch ModelHit, the fields used here). */
export interface RouteHit { kind: 'dataset' | 'column' | 'metric' | 'term' | 'table'; id: string; datasetId?: string; name: string; score: number }
/** A verified question the person may see: its wordings and the datasets it reads. */
export interface RouteVerified { texts: readonly string[]; datasetIds: readonly string[] }

export interface RouteAgent {
  id: string;
  description: string;
  /** Its topic's datasets, each with the fields it keeps (null: every field); null: no topic, all data. */
  datasets: ReadonlyMap<string, readonly string[] | null> | null;
  metricIds: ReadonlySet<string>;
  termIds: ReadonlySet<string>;
  /** The titles of its knowledge documents. */
  titles: readonly string[];
}

export interface Match { kind: MatchKind; name: string; points: number }
export interface Scored { id: string; score: number; matches: Match[] }

export const DESCRIPTION_WORD = 1;
export const TITLE_WORD = 2;
export const VERIFIED_WORD = 2;
/** The least score that is evidence: one stray description word is not. */
export const MIN_SCORE = 2;
/** The most agents offered as buttons when the call is close. */
export const MAX_CHOICES = 3;

const shared = (asked: ReadonlySet<string>, text: string): number => searchWords(text).filter((w) => asked.has(w)).length;

/** Every agent with a score, best first; an equal score keeps the input (list) order. */
export function scoreAgents(question: string, agents: readonly RouteAgent[], hits: readonly RouteHit[], verified: readonly RouteVerified[]): Scored[] {
  const asked = new Set(searchWords(question));
  const scored = agents.map((a): Scored => {
    const byName = new Map<string, Match>();
    const add = (kind: MatchKind, name: string, points: number): void => {
      if (points <= 0) return;
      const key = `${kind}\u0000${name}`;
      const had = byName.get(key);
      if (had) had.points += points;
      else byName.set(key, { kind, name, points });
    };
    if (a.datasets) {
      for (const h of hits) {
        if (h.kind === 'table') continue;
        const fields = h.datasetId !== undefined ? a.datasets.get(h.datasetId) : undefined;
        const onTopic = h.datasetId !== undefined && a.datasets.has(h.datasetId);
        const named = (h.kind === 'metric' && a.metricIds.has(h.id)) || (h.kind === 'term' && a.termIds.has(h.id));
        const kept = h.kind === 'column' ? onTopic && (!fields || fields.includes(h.name)) : onTopic || named;
        if (kept) add(h.kind, h.name, h.score > 0 ? h.score : 1);
      }
      for (const v of verified) {
        if (!v.datasetIds.length || !v.datasetIds.every((d) => a.datasets!.has(d))) continue;
        const n = Math.max(0, ...v.texts.map((t) => shared(asked, t)));
        add('verified', v.texts[0] ?? '', VERIFIED_WORD * n);
      }
    }
    for (const title of a.titles) add('document', title, TITLE_WORD * shared(asked, title));
    add('description', '', DESCRIPTION_WORD * shared(asked, a.description));
    const matches = [...byName.values()].sort((x, y) => y.points - x.points);
    return { id: a.id, score: matches.reduce((n, m) => n + m.points, 0), matches };
  });
  return scored.map((s, i) => ({ s, i })).sort((x, y) => y.s.score - x.s.score || x.i - y.i).map((x) => x.s);
}

export type Decision =
  | { kind: 'none' }
  | { kind: 'clear'; id: string }
  | { kind: 'close'; ids: string[] };

/** What the scores say: nothing to go on, a clear winner, or the agents (two to MAX_CHOICES) too close to tell. */
export function decide(scored: readonly Scored[]): Decision {
  const [first, second] = scored;
  if (!first || first.score < MIN_SCORE) return { kind: 'none' };
  if (!second || second.score === 0 || 2 * first.score >= 3 * second.score) return { kind: 'clear', id: first.id };
  const close = scored.filter((s) => 3 * s.score > 2 * first.score).slice(0, MAX_CHOICES); // the ones `clear` could not tell from the first
  return { kind: 'close', ids: close.map((s) => s.id) };
}

const phrase = (m: Match): string => {
  switch (m.kind) {
    case 'dataset': return msg.routeDataset(m.name);
    case 'column': return msg.routeColumn(m.name);
    case 'metric': return msg.routeMetric(m.name);
    case 'term': return msg.routeTerm(m.name);
    case 'verified': return msg.routeVerified();
    case 'document': return msg.routeDocument(m.name);
    default: return msg.routeDescription();
  }
};

/** "Matched the HR dataset and the payroll cost metric.": the two best matches, in the app's words. Empty when there are none. */
export function whyOf(s: Scored): string {
  const [a, b] = s.matches;
  return !a ? '' : b ? msg.routeMatchedTwo(phrase(a), phrase(b)) : msg.routeMatchedOne(phrase(a));
}
