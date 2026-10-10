// Is this failure "not on a Live dataset yet"? (docs/live-data/00-plan.md L2.6,
// D6) — PURE. The server says so in one of three ways, and every figure
// surface asks this one function instead of reading codes itself:
//
//   a handler's reply   {ok:false, code:'live_dataset', error}    (D6's safety net,
//                       also per item in a batch — one Live tile never fails a sheet)
//   the chart adapter   {ok:false, code:'live_refused', error, reason}   (L2.4:
//                       pivot, cohort, funnel, drivers, maps, raw points…)
//   the route           HTTP 409 {code:'live_dataset', message}  (an RpcError here)
//
// The sentence is always the server's (the catalog's, never warehouse text);
// this file only recognises it. A Live failure that is NOT "off for Live" —
// the warehouse timed out, was unreachable — is an ordinary error, retried.

/** Codes meaning "this feature is off for a Live dataset": the answer is a copy, not a retry. */
export const LIVE_OFF_CODES: ReadonlySet<string> = new Set(['live_dataset', 'live_refused']);

/** An Error that keeps the server's code — what a hook throws so a screen can still tell. */
export class LiveRefusalError extends Error {
  readonly code: string;
  /** The server's machine reason beside the sentence ('pivot', 'notSynced'…), when it sent one. */
  readonly reason?: string;
  constructor(code: string, message: string, reason?: string) {
    super(message);
    this.name = 'LiveRefusalError';
    this.code = code;
    if (reason) this.reason = reason;
  }
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * The server's sentence when `x` is an "off for Live" refusal — a reply, a
 * thrown RpcError or a LiveRefusalError — else null. Never invents words: a
 * refusal without a sentence reads as the generic one below.
 */
export function liveRefusalOf(x: unknown): string | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as { ok?: unknown; code?: unknown; error?: unknown; reason?: unknown; message?: unknown };
  if (!LIVE_OFF_CODES.has(text(o.code))) return null;
  if (!(x instanceof Error) && o.ok !== false) return null;
  // `reason` is a sentence on an answer card, a machine code beside `error` on a chart refusal.
  const reason = text(o.reason);
  return text(o.error) || text(o.message) || (/\s/.test(reason) ? reason : '') || LIVE_OFF_FALLBACK;
}

/** When a refusal arrives without a sentence (never expected): what it means, in the catalog's words. */
export const LIVE_OFF_FALLBACK = 'This is a Live dataset — this isn’t available on Live yet. Make a copy to use it.';

/**
 * The Error a reply's failure becomes: a LiveRefusalError for an "off for Live"
 * refusal (so the screen can offer a copy), a plain Error otherwise.
 */
export function replyError(reply: unknown, fallback: string): Error {
  const live = liveRefusalOf(reply);
  const o = (reply ?? {}) as { code?: unknown; error?: unknown; reason?: unknown };
  // A machine reason has no spaces; an answer card's `reason` is its sentence, already in `live`.
  if (live !== null) return new LiveRefusalError(text(o.code), live, /\s/.test(text(o.reason)) ? undefined : text(o.reason));
  return new Error(text(o.error) || text(o.reason) || fallback);
}
