// src/app/format.ts — the app's one formatter — as EXACT strings, across
// locales, number styles, currency positions, compact on/off and the three
// date styles. Every expected string is written out: a formatter is judged by
// what a reader sees, and "close enough" is a different number on a card.
//
// Node 24's ICU is the reference (CI runs the same major). fr-FR groups with
// U+202F and en-IN in lakhs; a currency symbol is held to its figure with
// U+00A0 — all spelled as escapes so the test says so.
//
//   npm run build:ts && node scripts/test-format.js

export {};
import { ok, failureCount, finish } from './selfcheck';

const f: typeof import('../src/app/format') = require('../src/app/format');

function eq(name: string, got: string, want: string): void {
  ok(`${name} → ${JSON.stringify(want)}`, got === want, `got ${JSON.stringify(got)}`);
}
function use(p: Record<string, unknown>): void {
  f.setFormatPrefs({ locale: 'en-US', ...p });
}

const MONEY = { kind: 'currency' as const, decimals: 0, compact: true };
const WHOLE = { kind: 'currency' as const, decimals: 0, compact: false };

// ── Numbers, by locale ───────────────────────────────────────────────────────
const byLocale: Array<[string, string, string, string]> = [
  // locale,  1234567.891,              5194598.73 compact, 0.132 percent
  ['en-US', '1,234,567.89', '5.2M', '13.2%'],
  ['en-GB', '1,234,567.89', '5.2M', '13.2%'],
  ['en-IN', '12,34,567.89', '5.2M', '13.2%'],
  ['de-DE', '1.234.567,89', '5,2M', '13,2%'],
  ['fr-FR', '1 234 567,89', '5,2M', '13,2%'],
  ['ja-JP', '1,234,567.89', '5.2M', '13.2%'],
];
for (const [locale, n, c, pct] of byLocale) {
  use({ locale });
  eq(`${locale} formatNumber(1234567.891)`, f.formatNumber(1234567.891), n);
  eq(`${locale} formatCompact(5194598.73)`, f.formatCompact(5194598.73), c);
  eq(`${locale} formatPercent(0.132)`, f.formatPercent(0.132), pct);
}

// ── Number styles override the locale's marks, and only the marks ───────────
const styles: Array<[string, string]> = [
  ['comma_dot', '1,234.56'], ['dot_comma', '1.234,56'], ['space_comma', '1\u00a0234,56'],
  ['apostrophe_dot', "1'234.56"], ['plain_dot', '1234.56'],
];
for (const [numberStyle, want] of styles) {
  use({ locale: 'de-DE', numberStyle });
  eq(`de-DE + ${numberStyle} formatNumber(1234.56)`, f.formatNumber(1234.56), want);
}
use({ numberStyle: 'dot_comma' });
eq('dot_comma keeps the minus sign first', f.formatNumber(-1234.5), '-1.234,5');

// ── Compact ──────────────────────────────────────────────────────────────────
use({});
eq('compact keeps one fixed decimal', f.formatCompact(5000), '5.0K');
eq('compact below 1,000 is the number', f.formatCompact(842.5), '842.5');
eq('rounding up names the next unit (never 1000.0K)', f.formatCompact(999_960), '1.0M');
eq('…and on to billions', f.formatCompact(999_999_999), '1.0B');
eq('…and trillions', f.formatCompact(4.2e12), '4.2T');
eq('negative compact', f.formatCompact(-1500), '-1.5K');
ok('null / NaN / Infinity print nothing', [null, undefined, NaN, Infinity].every((v) => f.formatCompact(v as never) === ''));
use({ compact: false });
eq('compact OFF prints the grouped number', f.formatCompact(5194598.73), '5,194,598.73');
eq('…and a currency figure in full', f.formatCurrency(5194598.73), '$5,194,599');

// ── Currency: symbol, position, and the per-metric format winning ───────────
use({});
eq('USD metric', f.formatMetric(5194598.73, MONEY), '$5.2M');
use({ currency: 'EUR' });
eq('EUR, before', f.formatMetric(5194598.73, MONEY), '€5.2M');
eq('EUR, whole, negative: minus first', f.formatMetric(-1200, WHOLE), '-€1,200');
use({ locale: 'de-DE', currency: 'EUR', currencyPosition: 'after' });
eq('de-DE EUR, after', f.formatMetric(5194598.73, MONEY), '5,2M\u00a0€');
eq('…whole, negative', f.formatMetric(-1200, WHOLE), '-1.200\u00a0€');
use({ currency: 'GBP' });
eq('GBP', f.formatCurrency(1200, { compact: false }), '£1,200');
use({ currency: 'CHF' });
eq('a symbol that is a word gets a space', f.formatCurrency(1200, { compact: false }), 'CHF\u00a01,200');
use({ currency: 'JPY' });
eq('JPY', f.formatCurrency(1200, { compact: false }), '¥1,200');
use({ currency: 'EUR' });
eq('a metric\'s own prefix wins over the workspace currency',
  f.formatMetric(5194598.73, { ...MONEY, prefix: '$' }), '$5.2M');
eq('percent metric', f.formatMetric(0.1325, { kind: 'percent', decimals: 1, compact: false }), '13.3%');
eq('number metric, compact, small', f.formatMetric(12.345, { kind: 'number', decimals: 1, compact: true }), '12.3');
eq('duration metric', f.formatMetric(5000, { kind: 'duration', decimals: 0, compact: false }), '1h 23m');
eq('no figure is an em dash, never 0', f.formatMetric(null, MONEY), '—');

// ── The chart/card format vocabulary ─────────────────────────────────────────
use({});
eq('formatValue auto', f.formatValue(686_234), '686.2K');
eq('formatValue plain', f.formatValue(1234.5678, 'plain'), '1,234.568');
eq('formatValue thousands', f.formatValue(1234.6, 'thousands'), '1,235');
eq('formatValue percent', f.formatValue(0.1234, 'percent'), '12.34%');
eq('formatValue currency', f.formatValue(1234.4, 'currency'), '$1,234');
eq('formatValue text passes through', f.formatValue('West', 'currency'), 'West');

// ── Dates ────────────────────────────────────────────────────────────────────
const dates: Array<[string, string, string, string]> = [
  ['en-US', '9/24/2026', 'Sep 24, 2026', 'Sep 1 – Sep 30, 2026'],
  ['en-GB', '24/09/2026', '24 Sept 2026', '1 Sept – 30 Sept 2026'],
  ['de-DE', '24.9.2026', '24. Sept. 2026', '1. Sept. – 30. Sept. 2026'],
  ['fr-FR', '24/09/2026', '24 sept. 2026', '1 sept. – 30 sept. 2026'],
];
for (const [locale, short, medium, range] of dates) {
  use({ locale, dateFormat: 'short' });
  eq(`${locale} short date`, f.formatDate('2026-09-24'), short);
  use({ locale, dateFormat: 'medium' });
  eq(`${locale} medium date`, f.formatDate('2026-09-24'), medium);
  eq(`${locale} range in one year`, f.formatDateRange('2026-09-01', '2026-09-30'), range);
}
use({ dateFormat: 'iso' });
eq('ISO date, whatever the locale', f.formatDate('2026-09-24'), '2026-09-24');
eq('ISO range keeps both years', f.formatDateRange('2026-09-01', '2026-09-30'), '2026-09-01 – 2026-09-30');
use({});
eq('a range across years names both', f.formatDateRange('2024-07-01', '2025-06-30'), 'Jul 1, 2024 – Jun 30, 2025');
eq('a timestamp reads as its day, in UTC', f.formatDate('2026-01-01T23:30:00Z'), 'Jan 1, 2026');
eq('not a date: returned as it is', f.formatDate('Q3'), 'Q3');

// ── Sanitizing ───────────────────────────────────────────────────────────────
const junk = f.sanitizeFormatPrefs({ locale: 'xx-XX', numberStyle: 'roman', currency: 'BTC', currencyPosition: 'middle',
  dateFormat: 'long', weekStart: 9, fiscalYearStart: 13, compact: 'no' });
ok('junk prefs fall back to the defaults (compact: any non-false is on)',
  JSON.stringify(junk) === JSON.stringify(f.FORMAT_DEFAULTS), JSON.stringify(junk));
ok('valid prefs survive', JSON.stringify(f.sanitizeFormatPrefs({ ...f.FORMAT_DEFAULTS, locale: 'de-DE', fiscalYearStart: 7, compact: false }))
  === JSON.stringify({ ...f.FORMAT_DEFAULTS, locale: 'de-DE', fiscalYearStart: 7, compact: false }));

// ── The renderer's way of loading it ─────────────────────────────────────────
// cjsShim.js makes a global `exports`, format.js fills it, formatBind.js takes
// it as OrdFormat and REMOVES the globals. Every function must still work after
// that — which a module-internal `exports.X` reference would break.
{
  const vm: typeof import('vm') = require('vm');
  const fs: typeof import('fs') = require('fs');
  const path: typeof import('path') = require('path');
  const ctx = vm.createContext({ Intl });
  vm.runInContext('var module = { exports: {} }; var exports = module.exports;', ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'format.js'), 'utf8'), ctx);
  vm.runInContext('var OrdFormat = module.exports; module = undefined; exports = undefined;', ctx);
  let out = '';
  try {
    out = vm.runInContext(`OrdFormat.setFormatPrefs({ locale: 'en-US', numberStyle: 'dot_comma', currency: 'EUR' });
      [OrdFormat.formatNumber(1234.5), OrdFormat.formatCompact(5194598.73), OrdFormat.formatCurrency(1200, { compact: false }),
       OrdFormat.formatValue(0.5, 'percent'), OrdFormat.formatDate('2026-09-24', 'iso'), OrdFormat.getFormatPrefs().currency,
       OrdFormat.NUMBER_STYLES.length, OrdFormat.LOCALES.length > 0].join('|')`, ctx);
  } catch (e) {
    out = String(e);
  }
  ok('every function works after the shim\'s globals are removed (renderer load)',
    out === '1.234,5|5,2M|€1.200|50%|2026-09-24|EUR|6|true', out);
}

// ── An exported dashboard carries the same formatter ─────────────────────────
{
  const vm: typeof import('vm') = require('vm');
  const fs: typeof import('fs') = require('fs');
  const path: typeof import('path') = require('path');
  const { buildSelfContainedHtml } = require('../src/analysis/dashboardExport') as typeof import('../src/analysis/dashboardExport');
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'format.js'), 'utf8');
  const html = buildSelfContainedHtml({ name: 'D', pages: [] }, '', { js, prefs: { locale: 'de-DE', currency: 'EUR', compact: 'x' } });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const at = scripts.findIndex((t) => t.includes('var module = { exports: {} }'));
  const ctx = vm.createContext({ Intl });
  let out = '';
  try {
    scripts.slice(at, at + 3).forEach((t) => vm.runInContext(t, ctx));
    out = vm.runInContext("OrdFormat.formatCompact(5194598.73) + '|' + OrdFormat.getFormatPrefs().currency", ctx);
  } catch (e) {
    out = String(e);
  }
  ok('an exported file loads the formatter with the workspace prefs', at > 0 && out === '5,2M|EUR', out);
  ok('…its chart ticks and tooltips call it', /F\.formatCompact\(v\)/.test(html) && /F\.formatNumber\(v,/.test(html));
  ok('…and without it the file still builds, on Chart.js defaults',
    !buildSelfContainedHtml({ name: 'D', pages: [] }, '').includes('var module'));
}

if (!failureCount()) console.log('\nAll format checks passed.');
finish();
