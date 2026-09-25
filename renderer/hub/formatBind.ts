'use strict';

// Binds src/app/format.js — the app's one formatter — as the global
// `OrdFormat`, then clears the shim's globals (see cjsShim.ts). Classic
// global-scope renderer <script>: no import/export.
//
// The shape below is the part of the module the renderer calls. It is typed
// here rather than imported because the renderer program cannot import a
// main-process module without re-emitting it (tsconfig.renderer.json).

interface OrdFormatApi {
  setFormatPrefs(p: any): void;
  getFormatPrefs(): any;
  formatNumber(v: number | null | undefined, opts?: { decimals?: number; maxDecimals?: number }): string;
  formatCompact(v: number | null | undefined): string;
  formatCurrency(v: number | null | undefined, opts?: { decimals?: number; compact?: boolean }): string;
  formatPercent(ratio: number | null | undefined, decimals?: number, opts?: { maxOnly?: boolean }): string;
  formatValue(v: unknown, mode?: string): string;
  formatDate(iso: string | null | undefined, style?: string, withYear?: boolean): string;
  formatDateRange(from?: string, to?: string): string;
  currencySymbol(code?: string): string;
  LOCALES: ReadonlyArray<{ id: string; label: string }>;
  CURRENCIES: readonly string[];
  NUMBER_STYLES: ReadonlyArray<{ id: string; label: string }>;
  FORMAT_DEFAULTS: any;
}

const OrdFormat: OrdFormatApi = (window as any).module.exports;
(window as any).module = undefined;
(window as any).exports = undefined;
