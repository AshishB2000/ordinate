// A row access refusal (docs/row-policy/00-design.md D15) — its code, reasons,
// fixed catalog sentences, and the typing of a refusal a handler caught. Its own
// light module, so the engines (the JS fold, the resident filter, the Live spec)
// can throw it for a lock that cannot be honoured without importing the gate.

import * as msg from './rowAccessMessages';

export const ROW_POLICY_CODE = 'row_policy';
export type RowPolicyReason = 'none' | 'column' | 'pipeline' | 'reader' | 'related' | 'asOf' | 'fanout' | 'export' | 'derived' | 'unreadable';

const SENTENCES: Record<RowPolicyReason, () => string> = {
  none: msg.rowNoneMessage,
  column: msg.rowColumnMessage,
  pipeline: msg.rowPipelineMessage,
  reader: msg.rowReaderMessage,
  related: msg.rowRelatedMessage,
  asOf: msg.rowAsOfMessage,
  fanout: msg.rowFanOutMessage,
  export: msg.rowExportMessage,
  derived: msg.rowDerivedMessage,
  unreadable: msg.rowUnreadableMessage,
};

let raised = 0;

/** A refusal: the route answers it 409 `row_policy` with its sentence. Never caught to become an empty answer. */
export class RowPolicyError extends Error {
  readonly code = ROW_POLICY_CODE;
  readonly reason: RowPolicyReason;
  constructor(reason: RowPolicyReason) {
    super(SENTENCES[reason]());
    this.name = 'RowPolicyError';
    this.reason = reason;
    raised++;
  }
}

/** True for a RowPolicyError — by class, or by name and code when it crossed a module copy. */
export function isRowPolicyError(err: unknown): err is RowPolicyError {
  if (err instanceof RowPolicyError) return true;
  const e = err as { name?: unknown; code?: unknown } | null;
  return !!e && typeof e === 'object' && e.name === 'RowPolicyError' && e.code === ROW_POLICY_CODE;
}

/** How many refusals this process has raised — the route walks a reply for them only when this moved. */
export function rowPolicyRaised(): number {
  return raised;
}

/** The refusal as a reply, for a handler or a door whose contract answers `{ok:false, error}`. */
export function rowPolicyRefusal(reason: RowPolicyReason): { ok: false; code: typeof ROW_POLICY_CODE; reason: RowPolicyReason; error: string } {
  return { ok: false, code: ROW_POLICY_CODE, reason, error: SENTENCES[reason]() };
}

/**
 * Type the refusals a handler caught: every `{ok:false}` whose `error` (or
 * `reason`) IS one of the sentences gets the code and the reason — per item in
 * a batch, a few levels deep, as `tagLiveRefusals` does. Mutates and returns.
 */
export function tagRowPolicyRefusals<T>(reply: T, depth = 3): T {
  const bySentence = new Map((Object.keys(SENTENCES) as RowPolicyReason[]).map((r) => [SENTENCES[r](), r]));
  const walk = (v: unknown, d: number): void => {
    if (d < 0 || !v || typeof v !== 'object' || ArrayBuffer.isView(v)) return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, d - 1);
      return;
    }
    const o = v as Record<string, unknown>;
    const said = typeof o.error === 'string' ? o.error : typeof o.reason === 'string' ? o.reason : '';
    const reason = o.ok === false && o.code === undefined ? bySentence.get(said) : undefined;
    if (reason) {
      o.code = ROW_POLICY_CODE;
      if (typeof o.reason !== 'string') o.reason = reason; // an answer card's `reason` is its sentence: kept
      if (typeof o.error !== 'string') o.error = said;
    }
    for (const x of Object.values(o)) if (x && typeof x === 'object') walk(x, d - 1);
  };
  walk(reply, depth);
  return reply;
}
