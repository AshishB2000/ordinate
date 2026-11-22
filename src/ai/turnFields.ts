// Two of a stored turn's fields, re-sanitized when turns are read back (./copilot.ts normalizeTurns).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // as ./copilot.ts isValidId
const isValidId = (id: unknown): id is string => typeof id === 'string' && UUID_RE.test(id);

/** A dataset name the out-of-scope card names: one line, as a dataset's name is cut. */
export function sanitizeOutside(raw: unknown): { dataset: string } | undefined {
  const d = (raw as { dataset?: unknown } | null)?.dataset;
  const dataset = typeof d === 'string' ? d.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return dataset ? { dataset } : undefined;
}

/** A turn's `factsFrom`: its dataset ids, once each. */
export function sanitizeIds(raw: unknown): string[] | undefined {
  const ids = Array.isArray(raw) ? [...new Set(raw.filter(isValidId))] : [];
  return ids.length ? ids : undefined;
}
