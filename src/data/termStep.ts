// The glossary `term` filter step (semantic layer) and the typed refusal of a reader that cannot
// expand it. A term is a REFERENCE to a named filter: a door expands it to the term's own steps
// before any engine runs, so an engine that meets one is a bug or an old pod, and refuses the
// figure — never skips the step (it would widen the figure) and never drops it (it would delete
// the reference on the next save). Its own light module, as rowPolicyError.ts is, so the JS fold,
// the resident filter and the Live compiler can throw it without importing a door.

import * as msg from './termMessages';

/** A reference to a glossary term, in a `filters` / `liveFilters` list. NOT a Prepare step (`sanitizeSteps` drops it). */
export interface TermStep {
  type: 'term';
  /** The term's record id. */
  term: string;
  /** Made by a dashboard control, as a filter step's flag is. */
  fromControl?: true;
}

export function isTermStep(s: unknown): s is TermStep {
  const o = s as { type?: unknown; term?: unknown } | null;
  return !!o && typeof o === 'object' && o.type === 'term' && typeof o.term === 'string';
}

/** Any step claiming `type: 'term'`, well-formed or not: what the JS fold refuses, so every engine refuses exactly that. */
export function hasTermType(s: unknown): boolean {
  return !!s && typeof s === 'object' && (s as { type?: unknown }).type === 'term';
}

export const TERM_CODE = 'term';
export type TermReason = 'not_expanded' | 'unreadable' | 'deleted' | 'unreachable' | 'column_gone';

/** A refusal: the route answers it 409 `term` with its sentence. Never caught to become a skipped step or an empty answer. */
export class TermNotExpandedError extends Error {
  readonly code = TERM_CODE;
  readonly reason: TermReason;
  constructor(reason: TermReason, message?: string) {
    super(message ?? (reason === 'unreadable' ? msg.termUnreadable() : msg.termNotExpanded()));
    this.name = 'TermNotExpandedError';
    this.reason = reason;
  }
}

/** The refusal for a term-shaped step an engine met: 'not_expanded' when it names its term (a string id), 'unreadable' when it does not. */
export function termError(s: unknown): TermNotExpandedError {
  const id = (s as { term?: unknown } | null | undefined)?.term;
  return new TermNotExpandedError(typeof id === 'string' ? 'not_expanded' : 'unreadable');
}

/** True for a TermNotExpandedError — by class, or by name and code when it crossed a module copy. */
export function isTermNotExpandedError(err: unknown): err is TermNotExpandedError {
  if (err instanceof TermNotExpandedError) return true;
  const e = err as { name?: unknown; code?: unknown } | null;
  return !!e && typeof e === 'object' && e.name === 'TermNotExpandedError' && e.code === TERM_CODE;
}

/** The refusal as a reply, for a door whose contract answers `{ok:false, error}`. */
export function termRefusal(err: TermNotExpandedError): { ok: false; code: typeof TERM_CODE; reason: TermReason; error: string } {
  return { ok: false, code: TERM_CODE, reason: err.reason, error: err.message };
}
