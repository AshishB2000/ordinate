// Typing the refusals a handler caught. Most handlers answer `{ok:false, error: err.message}`, and a
// batch answers per item, so the RPC route (and analysesServer's `call`) walks a reply for each refusal
// whose sentence is fixed: row access rules (./rowPolicyError) and a filter step this pod cannot apply
// (./termStep). ONE walk for both. No imports, so either light module can use it without a cycle.

/**
 * Every `{ok:false}` with no code whose `error` (or `reason`) IS a sentence of `bySentence` gets `code`
 * and that sentence's reason — per item in a batch, a few levels deep. Mutates and returns.
 */
export function tagRefusals<T>(reply: T, bySentence: ReadonlyMap<string, string>, code: string, depth = 3): T {
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
      o.code = code;
      if (typeof o.reason !== 'string') o.reason = reason; // an answer card's `reason` is its sentence: kept
      if (typeof o.error !== 'string') o.error = said;
    }
    for (const x of Object.values(o)) if (x && typeof x === 'object') walk(x, d - 1);
  };
  walk(reply, depth);
  return reply;
}
