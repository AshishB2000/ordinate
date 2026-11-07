// A figure this release keeps but cannot compute (semantic layer part 5, D4): a count distinct, or a metric kind a
// newer release writes. Thrown by an engine that meets one; the route answers it 409 `pending` with its sentence.
// Never caught into an empty answer, and never a skipped Prepare step (that would write an ungrouped table).

import * as msg from '../analysis/pendingMessages';

export const PENDING_CODE = 'pending';

export class PendingError extends Error {
  readonly code = PENDING_CODE;
  constructor(readonly what: 'countd' | 'kind', subject = '') {
    super(what === 'countd' ? msg.countdPending(subject) : msg.metricKindPending(subject));
    this.name = 'PendingError';
  }
}

export function isPendingError(e: unknown): e is PendingError {
  if (e instanceof PendingError) return true;
  const o = e as { name?: unknown; code?: unknown } | null;
  return !!o && typeof o === 'object' && o.name === 'PendingError' && o.code === PENDING_CODE;
}
