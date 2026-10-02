// Proleptic-Gregorian civil date <-> epoch day — PURE, no imports. Split out of
// categoryKey so the week calendars (retailCalendar) can use it without an
// import cycle; categoryKey re-exports both names, so no caller moved.

export interface CivilDate {
  y: number;
  m: number;
  d: number;
}

// Howard Hinnant's civil↔days pair. Chosen over `Date.UTC` because that maps
// years 0–99 into 1900–1999, and over a hand-rolled leap-year loop because this
// is exact for every proleptic-Gregorian date — the same calendar DuckDB uses,
// which is what makes `dateBucket` equal `epoch day of date_trunc(...)`.
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z: number): CivilDate {
  const n = z + 719468;
  const era = Math.floor(n / 146097);
  const doe = n - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}
