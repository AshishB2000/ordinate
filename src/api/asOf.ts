// How fresh a figure is (docs/live-data/00-plan.md, L0.2) — the ONE shape every
// chart, KPI and answer reply carries as `asOf`, beside the figure it dates.
// Types only: the web imports it type-only (web/src/ui/asOf.ts formats it), so
// a renamed field fails tsc in both halves, and nothing here reaches the bundle.
//
// The server sets it; the browser only formats it ("As of 1:00 AM"). It is
// built so later phases only SET fields: an extract today is
// `{ at: lastRefreshedAt, mode: 'extract' }`; a live dataset (L2) answers with
// `{ at: fetchedAt, mode: 'live', cached }`, a warehouse failure served from the
// cache adds `stale`, and a fresh-on-ask pull still running (L3.1) `refreshing`.
//
// Not to be confused with the REQUEST field `asOf` (src/data/asOf.ts): that one
// is a snapshot time to read the data as of; this one says how old the data
// behind a reply is. Inside an as-of read the two agree — the reply is dated
// with the snapshot's time.

export interface AsOf {
  /** ISO 8601 (UTC): when the rows under the figure are from — an extract's last refresh, a live query's answer. */
  at: string;
  /** `extract`: our Parquet copy. `live`: the source warehouse, asked for this figure (L2). */
  mode: 'extract' | 'live';
  /** Live only: served from the result cache rather than asked just now. */
  cached?: boolean;
  /** The source could not answer, so this is the last figure it gave ("Stale · as of …"). */
  stale?: boolean;
  /** A newer copy is being pulled; the figure moves when it lands ("· refreshing…"). */
  refreshing?: boolean;
}
