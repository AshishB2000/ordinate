// The date range a stored Live result covers, and the one it defaults to — MAIN, pure. A reader that cannot read every row of a table that
// requires a date range (the key check, the schema sync's sample: src/engine/live/liveDateRange.ts `lookupRequired`)
// reads inside the range and stores its days beside what it found, so a 12-month count never reads as the whole
// table's. Absent: every row, as every result stored before this field was.

import type { PeriodSpec } from '../analysis/dateIntel';
import { describePeriod, getCalendar } from '../analysis/dateIntel';

/** The range a question or reader on a table that requires one gets when it names none: the date control's "Last 12 months". */
export const REQUIRED_RANGE: PeriodSpec = { preset: 'last_n_months', n: 12 };

/** REQUIRED_RANGE's name under the org's calendar: "Last 12 months". */
export const requiredPeriod = (): string => describePeriod(REQUIRED_RANGE, getCalendar());

/** The inclusive ISO days a read was held to; either end may be open. */
export interface LiveRange { from?: string; to?: string }

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v));

/** A stored range made safe, or undefined when none is stored. A hand-edited end is dropped, never the range: `{}` still says "not every row". */
export function sanitizeRange(raw: unknown): LiveRange | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  return { ...(isDay(o.from) && { from: o.from }), ...(isDay(o.to) && { to: o.to }) };
}
