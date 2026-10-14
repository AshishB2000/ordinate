// Which period a scorecard page shows, as its URL says it: `?back=N`, N periods
// before the current one. The page writes it (ScorecardPage.tsx) and the
// Assistant reads it (assistant/dockState.ts), so a reload keeps the period and
// a question is about the one on screen.

/** As far back as `scorecard:compute` goes (src/api/reports.ts `Offset`). */
export const MAX_BACK = 600;

/** Periods back from the current one — 0 when the URL names none, or names anything the server would refuse. */
export function periodsBack(search: URLSearchParams): number {
  const n = Number(search.get('back'));
  return Number.isInteger(n) && n > 0 && n <= MAX_BACK ? n : 0;
}
