// Certified and retired status as the server sent it (`status` on metric:list, term:list, dataset:list, catalog:list).
// The web never decides a status: it orders, words and draws what arrived. `PIN_FIELDS` is a HINT for the save
// warning only; the truth lives on the server.

export type StatusState = 'certified' | 'needs_review' | 'retired';
export interface StatusView {
  state: StatusState;
  by: string;
  at: string;
  note: string;
  versionKey?: string;
  replacedBy?: { ref: string; name: string };
}
export type StatusKind = 'metric' | 'term' | 'dataset';

/** certified first, then the unmarked and the changed-since-certified, then retired. */
export const STATUS_RANK: Record<StatusState | 'none', number> = { certified: 0, none: 1, needs_review: 1, retired: 2 };

/** One order for every picker: stable within a rank (the caller's own order, by name or as the server sent it). */
export function pickerOrder<T extends { name: string; status?: StatusView }>(items: T[]): { main: T[]; retired: T[] } {
  const rank = (x: T) => STATUS_RANK[x.status?.state ?? 'none'];
  const sorted = items.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i).map((e) => e.x);
  return { main: sorted.filter((x) => x.status?.state !== 'retired'), retired: sorted.filter((x) => x.status?.state === 'retired') };
}

// Mirrors the `pin` rows of METRIC_PIN and TERM_PIN in src/analysis/statusPin.ts (a record field that moves the pin).
export const PIN_FIELDS: { metric: readonly string[]; term: readonly string[] } = {
  metric: ['name', 'datasetId', 'definition', 'filters', 'format', 'timeColumn'],
  term: ['name', 'datasetId', 'filters'],
};

/** Does saving this patch move the pin of a certified item? A hint for the warning. */
export const movesPin = (kind: 'metric' | 'term', patch: object): boolean => PIN_FIELDS[kind].some((f) => f in patch);

const when = (at: string) => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** "Certified by ana@acme.com · Nov 3 · note" */
export const statusTitle = (s: StatusView): string => {
  const head = s.state === 'retired' ? 'Retired' : 'Certified';
  return [`${head} by ${s.by}`, when(s.at), s.note].filter(Boolean).join(' · ');
};
