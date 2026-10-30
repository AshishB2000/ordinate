// The calendar, number formats and language every figure and server sentence
// is written in are an ORG's settings (config.ts `formats`, `language`). One
// server process serves every org, so each lives per org here: set by
// config.load()/persist() for the org they ran for, read for the caller's org —
// never a process-wide copy of whichever org loaded its config last (NV-1).
// A desktop, a self-check and code outside a request keep each module's own slot.

import { ctx, serverDataDir } from '../server/context';
import { scopeCalendar } from '../analysis/dateIntel';
import { scopeFormatPrefs } from './format';
import { scopeLanguage } from './i18n';

interface Slot<T> { get(): T; set(v: T): void }

function orgNow(): string | undefined {
  if (serverDataDir() === null) return undefined;
  try { return ctx().org.id; } catch { return undefined; } // outside a request: no org to act for
}

/**
 * Wraps each module's own slot with one per org. `fill` loads the caller's
 * org's settings (which sets them here) the first time this process reads them.
 */
export function scopeAmbientByOrg(fill: () => void): void {
  let filling = false;
  const perOrg = <T>(own: Slot<T>): Slot<T> => {
    const byOrg = new Map<string, T>();
    return {
      get(): T {
        const org = orgNow();
        if (org === undefined) return own.get();
        if (!byOrg.has(org) && !filling) {
          filling = true;
          try { fill(); } finally { filling = false; }
        }
        return byOrg.has(org) ? byOrg.get(org) as T : own.get();
      },
      set(v: T): void {
        const org = orgNow();
        if (org === undefined) own.set(v);
        else byOrg.set(org, v);
      },
    };
  };
  scopeCalendar(perOrg);
  scopeFormatPrefs(perOrg);
  scopeLanguage(perOrg);
}
