// ── Headline writer — PURE JS, NO AI numbers ────────────────────────────────
// Turns the engine's computed metrics (src/calc.js) + the AI's headline hint
// ({ focus, angle }) into a short, highlighted paragraph (2-4 sentences):
//   - leads with the AI's number-FREE angle sentence,
//   - then weaves in up to 3 featured metrics via OUR sentence templates,
//   - bolds every figure, and EVERY figure comes from the engine (never the AI).
//
// Output: { segments: [{text, bold?}], plain, numbers: [<bold strings>] }.
// The renderer paints `segments` (bold -> <strong>). `numbers` is the set of
// figures we injected; verifyHeadlineNumbers() confirms nothing else numeric
// slipped in (e.g. an AI-emitted figure), so the headline can be trusted or dropped.

interface Segment { text: string; bold?: boolean }
// A sentence part: plain text, or {b: <figure>} — b may be null when a figure
// failed to format (sentence() then drops the whole clause).
type SentencePart = string | { b: string | null };
export interface HeadlineProse { segments: Segment[]; plain: string; numbers: string[] }

// ── number formatting (headline = compact; detail tables keep full precision) ──
function stripZeros(s: string): string { return s.replace(/\.0+$/, ''); }
export function abbrev(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1e9) return sign + stripZeros((a / 1e9).toFixed(2)) + 'B';
  if (a >= 1e6) return sign + stripZeros((a / 1e6).toFixed(2)) + 'M';
  if (a >= 1e3) return sign + stripZeros((a / 1e3).toFixed(1)) + 'K';
  return sign + (Number.isInteger(a) ? String(a) : stripZeros(a.toFixed(2)));
}
// A percent "rounds to zero" at `d` decimals — clauses reword these as "flat"
// rather than ever printing "-0%"/"+0%".
function isFlatPct(n: number | null | undefined, d = 1): boolean { return n != null && Number.isFinite(n) && parseFloat(Number(n).toFixed(d)) === 0; }
// Compact percent / share, never a signed zero (defensive — clauses normally
// reword flat values before calling these).
function hpct(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = n.toFixed(1);
  if (parseFloat(f) === 0) return '0%';
  return (parseFloat(f) > 0 ? '+' : '') + stripZeros(f) + '%';
}
function hshare(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = n.toFixed(1);
  if (parseFloat(f) === 0) return '0%';
  return stripZeros(f) + '%';
}

// segment helpers
function t(text: string): Segment { return { text }; }
function b(text: string): Segment { return { text, bold: true }; }
// Build a sentence from parts: a string is plain text, {b:'x'} becomes a bold
// figure. Returns null if any required figure is missing (caller skips the clause).
function sentence(parts: SentencePart[]): Segment[] | null {
  const segs: Segment[] = [];
  for (const p of parts) {
    if (typeof p === 'string') { segs.push(t(p)); continue; }
    if (p && typeof p.b === 'string') { segs.push(b(p.b)); continue; }
    return null; // a figure failed to format -> drop the whole clause, never print a hole
  }
  return segs;
}

// ── clause templates (one per calc id). Each returns sentence segments or null ──
// RULE: figures appear ONLY in bold segments; never put a bare number in plain
// text. That keeps verifyHeadlineNumbers() exact and bulletproof.
// ponytail: `res` is a calc result whose raw shape varies per calc id — any.
const CLAUSES: Record<string, (res: any) => Segment[] | null> = {
  total_change(res) {
    const rows = (res.raw.rows || []).filter((r: any) => Number.isFinite(r.abs));
    if (!rows.length) return null;
    const sorted = rows.slice().sort((a: any, c: any) => c.abs - a.abs);
    const top = sorted[0], bottom = sorted[sorted.length - 1];
    // Append the % only when it doesn't round to zero (the absolute figure carries it otherwise).
    const parts: SentencePart[] = [`${top.label} grew the most, adding `, { b: abbrev(top.abs) }];
    if (!isFlatPct(top.pct)) parts.push(' (', { b: hpct(top.pct) }, ')');
    if (bottom !== top && bottom.abs < 0) {
      parts.push(`, while ${bottom.label} fell by `, { b: abbrev(Math.abs(bottom.abs)) });
      if (!isFlatPct(bottom.pct)) parts.push(' (', { b: hpct(bottom.pct) }, ')');
    }
    parts.push('.');
    return sentence(parts);
  },
  yoy_pct_change(res) {
    const rows = (res.raw.rows || []).filter((r: any) => Number.isFinite(r.pct));
    if (!rows.length) return null;
    const top = rows.slice().sort((a: any, c: any) => c.pct - a.pct)[0];
    if (isFlatPct(top.pct)) return sentence([`${top.label} was essentially unchanged most recently.`]);
    return sentence([`${top.label} moved most recently at `, { b: hpct(top.pct) }, '.']);
  },
  concentration_top_n(res) {
    if (!Number.isFinite(res.raw.top3Share)) return null;
    return sentence(['The top three hold ', { b: hshare(res.raw.top3Share) }, ' of the total.']);
  },
  rank_by_growth(res) {
    const rows = res.raw.rows || [];
    if (!rows.length) return null;
    const fast = rows[0], slow = rows[rows.length - 1];
    if (isFlatPct(fast.pct)) return sentence([`${fast.label} led, though recent growth was essentially flat.`]);
    const parts: SentencePart[] = [`${fast.label} posted the fastest recent growth at `, { b: hpct(fast.pct) }];
    if (slow !== fast) {
      if (isFlatPct(slow.pct)) parts.push(`, while ${slow.label} held flat`);
      else if (slow.pct < 0) parts.push(`, while ${slow.label} slipped `, { b: hpct(slow.pct) });
    }
    parts.push('.');
    return sentence(parts);
  },
  rank_by_value(res) {
    const rows = res.raw.rows || [];
    if (!rows.length) return null;
    const top = rows[0];
    return sentence([`${top.label} is the largest at `, { b: abbrev(top.value) }, '.']);
  },
  pct_of_total(res) {
    const rows = res.raw.rows || [];
    if (!rows.length) return null;
    const top = rows.slice().sort((a: any, c: any) => c.pct - a.pct)[0];
    if (isFlatPct(top.pct)) return null; // a ~0% share isn't headline-worthy
    return sentence([`${top.label} alone is `, { b: hshare(top.pct) }, ' of the total.']);
  },
  gap_to_average(res) {
    const rows = res.raw.rows || [];
    if (!rows.length) return null;
    const top = rows.slice().sort((a: any, c: any) => Math.abs(c.absGap) - Math.abs(a.absGap))[0];
    if (!top || top.pctGap == null) return null;
    if (isFlatPct(top.pctGap)) return sentence([`${top.label} sits right around the average.`]);
    return sentence([`${top.label} runs `, { b: hshare(Math.abs(top.pctGap)) }, ` ${top.above ? 'above' : 'below'} the average.`]);
  },
  cagr(res) {
    const rows = res.raw.rows || [];
    if (!rows.length) return null;
    const top = rows.slice().sort((a: any, c: any) => c.cagr - a.cagr)[0];
    if (isFlatPct(top.cagr)) return sentence([`${top.label} was roughly flat over the period.`]);
    const unit = res.raw.assumed ? 'per period' : 'per year';
    return sentence([`${top.label} compounded fastest at `, { b: hpct(top.cagr) }, ` ${unit}.`]);
  },
  acceleration(res) {
    const acc = (res.raw.rows || []).find((r: any) => r.flag === 'accelerating');
    if (!acc) return null;
    return sentence([`${acc.label}'s growth is accelerating.`]); // no figure — name stays plain
  },
};

// Join sentences with a clean ". " — terminate the previous sentence first if it
// isn't already (the AI's angle usually arrives with no end punctuation), then a
// single space, so no two sentences ever run together. The period is its own plain
// segment so it's never bolded and verifyHeadlineNumbers() stays exact.
function endsSentence(text: string | undefined): boolean { return /[.!?]["')\]]?\s*$/.test(text || ''); }
function appendSentence(segs: Segment[], sentenceSegs: Segment[] | null | undefined): void {
  if (!sentenceSegs || !sentenceSegs.length) return;
  if (segs.length) {
    const last = segs[segs.length - 1];
    if (!endsSentence(last && last.text)) segs.push(t('.'));
    segs.push(t(' '));
  }
  for (const s of sentenceSegs) segs.push(s);
}

// ── de-dup: never feature the same row+figure in two clauses ────────────────
// Every row label present in the computed metrics (used to spot the subject of a
// built clause from its text).
function collectLabels(results: Record<string, any>): string[] {
  const set = new Set<string>();
  for (const id of Object.keys(results)) {
    const rows = (results[id].raw && results[id].raw.rows) || [];
    for (const r of rows) if (r && typeof r.label === 'string' && r.label) set.add(r.label);
  }
  return [...set];
}
// The earliest-mentioned label in a clause's text (text order, not list order).
function firstLabelInText(text: string, labels: string[]): string | null {
  let best: string | null = null, bestIdx = Infinity;
  for (const l of labels) {
    const i = text.indexOf(l);
    if (i >= 0 && i < bestIdx) { bestIdx = i; best = l; }
  }
  return best;
}
// A clause's headline fact: its subject row paired with its first figure, e.g.
// "North Carolina|+1.3%". Two clauses with the same fact restate the same
// row+number — the later one is dropped. Figure-only (concentration) or
// figure-less (acceleration) clauses have no row+figure pair → null → never dedupe.
// ponytail: keys the PRIMARY fact only — kills the reported whole-clause repeats;
// a merely shared secondary figure isn't chased.
function clauseFact(clauseSegs: Segment[], labels: string[]): string | null {
  const text = clauseSegs.map(s => s.text).join('');
  const label = firstLabelInText(text, labels);
  const figSeg = clauseSegs.find(s => s.bold && typeof s.text === 'string');
  if (!label || !figSeg) return null;
  return label + '|' + normNum(figSeg.text);
}

// Build the headline paragraph. metrics = { selected, results } from calc.js;
// hint = AI's { focus, angle } (may be null). Returns prose object or null when
// there is genuinely nothing to say (renderer then shows just the analysis text).
// maxFeatured caps how many computed clauses follow the angle (default 3). A
// brevity global rule passes 1 so the whole headline stays short, not just the
// analysis — the angle still leads, then only the single most important figure.
// ponytail: metrics/hint arrive from the model envelope + engine — typed loosely.
export function writeHeadline(metrics: any, hint: any, maxFeatured?: number): HeadlineProse | null {
  const results: Record<string, any> = (metrics && metrics.results) || {};
  const focus: string[] = (hint && Array.isArray(hint.focus)) ? hint.focus : [];
  const angle = (hint && typeof hint.angle === 'string') ? hint.angle.trim() : '';
  const cap = (typeof maxFeatured === 'number' && maxFeatured >= 0) ? maxFeatured : 3;

  const segs: Segment[] = [];
  // Lead with the AI's angle ONLY if it is number-free — the AI must never emit a
  // figure; if it did, we drop the angle rather than surface an unverified number.
  if (angle && !/\d/.test(angle)) appendSentence(segs, [t(angle)]);

  // Featured clauses, AI order first, capped at 3, skipping unsupported calcs and
  // any clause that would restate a row+figure an earlier clause already stated.
  const order = focus.length ? focus : Object.keys(results);
  const allLabels = collectLabels(results);
  let used = 0;
  const seen = new Set<string>();       // calc ids already attempted
  const seenFacts = new Set<string>();  // row+figure facts already featured
  for (const id of order) {
    if (used >= cap) break;
    if (seen.has(id)) continue;
    seen.add(id);
    const builder = CLAUSES[id];
    if (!builder || !results[id]) continue;
    let clause: Segment[] | null = null;
    try { clause = builder(results[id]); } catch (_) { clause = null; }
    if (!clause || !clause.length) continue;
    const fact = clauseFact(clause, allLabels);
    if (fact && seenFacts.has(fact)) continue; // duplicate row+figure -> adds no new fact
    if (fact) seenFacts.add(fact);
    appendSentence(segs, clause);
    used++;
  }

  // Fallback: angle had a number/was empty AND no focus clause fired — synthesize
  // from whatever did compute so we still produce a sensible paragraph.
  if (!used && !segs.length) {
    for (const id of Object.keys(results)) {
      const builder = CLAUSES[id];
      if (!builder) continue;
      let clause: Segment[] | null = null;
      try { clause = builder(results[id]); } catch (_) { clause = null; }
      if (clause && clause.length) { appendSentence(segs, clause); break; }
    }
  }
  if (!segs.length) return null;

  const plain = segs.map(s => s.text).join('');
  const numbers = segs.filter(s => s.bold).map(s => s.text);
  return { segments: segs, plain, numbers };
}

// Standalone figures in text (e.g. "2.56M", "+8.5%", "82.6%"); ignores digits
// embedded in words like a category name "Region 2".
const NUM_TOKEN = /(?<![A-Za-z0-9])[+\-]?\d[\d,]*(?:\.\d+)?\s?[%KMB]?(?![A-Za-z0-9])/g;
const normNum = (s: string) => s.replace(/\s/g, '');

// Correctness gate: every figure shown in the headline must be one we injected
// from the engine. Returns { ok, stray:[...] }. Used as a guardrail in main (drop
// the headline if it ever fails) and asserted in the self-check.
export function verifyHeadlineNumbers(prose: any): { ok: boolean; stray: string[] } {
  if (!prose || typeof prose.plain !== 'string') return { ok: true, stray: [] };
  const allowed = new Set((prose.numbers || []).map(normNum));
  const tokens = prose.plain.match(NUM_TOKEN) || [];
  const stray = tokens.map(normNum).filter((tok: string) => !allowed.has(tok));
  return { ok: stray.length === 0, stray };
}

// ── self-check: `node src/headline.js` ──────────────────────────────────────
if (require.main === module) {
  // Explicit annotation (not a cast): assert.ok is an assertion function, and
  // TS requires the call target itself to carry a declared type (TS2775).
  const assert: typeof import('assert') = require('assert');
  const { computeMetrics }: typeof import('./calc') = require('./calc');

  const table = {
    columns: [
      { id: 'state', label: 'State', role: 'category', type: 'text' },
      { id: 'y2024', label: '2024', role: 'period', type: 'number', periodOrder: 1 },
      { id: 'y2025', label: '2025', role: 'period', type: 'number', periodOrder: 2 },
    ],
    rows: [
      { state: 'California', y2024: 39000000, y2025: 39200000 },
      { state: 'Texas', y2024: 30000000, y2025: 30375000 },
      { state: 'Florida', y2024: 22000000, y2025: 22600000 },
      { state: 'New York', y2024: 19500000, y2025: 19400000 },
    ],
  };
  const roles = { category: 'state', periods: ['y2024', 'y2025'], total: null, primaryValue: 'y2025' };
  const metrics = computeMetrics(table, roles, [
    'total_change', 'concentration_top_n', 'rank_by_growth', 'rank_by_value', 'pct_of_total',
  ]);

  // 1) Normal headline: angle leads, figures bolded, all verified.
  const hint = {
    focus: ['total_change', 'concentration_top_n', 'rank_by_growth'],
    angle: 'Growth is concentrated in the largest states while others stall.',
  };
  const prose = writeHeadline(metrics, hint)!;
  assert.ok(prose && prose.segments.length, 'prose produced');
  assert.ok(prose.plain.startsWith(hint.angle), 'leads with the angle');
  assert.ok(prose.numbers.length >= 3, 'several figures injected');
  const v = verifyHeadlineNumbers(prose);
  assert.ok(v.ok, 'no stray numbers: ' + JSON.stringify(v.stray));
  console.log('--- generated headline (bold shown as **x**) ---');
  console.log(prose.segments.map(s => s.bold ? `**${s.text}**` : s.text).join(''));
  console.log('injected figures:', prose.numbers.join(', '));

  // Florida grew most (+600K) and is fastest; top-3 share 82.6%
  assert.ok(prose.plain.includes('Florida grew the most'), 'biggest gainer clause');
  assert.ok(prose.numbers.includes('600K'), 'Florida +600K bolded');
  assert.ok(prose.numbers.includes('82.6%'), 'top-3 share bolded');

  // 2) AI angle containing a number is DROPPED (AI must not emit figures).
  const dirty = writeHeadline(metrics, { focus: ['rank_by_value'], angle: 'Texas surged 8% last year.' })!;
  assert.ok(!dirty.plain.includes('8%'), 'numeric angle dropped');
  assert.ok(verifyHeadlineNumbers(dirty).ok, 'still clean after dropping angle');
  console.log('CHECK: numeric AI angle dropped, headline still clean');

  // 3) Stray number is caught.
  const tampered = { plain: 'Texas grew 999 units.', numbers: [], segments: [] };
  assert.strictEqual(verifyHeadlineNumbers(tampered).ok, false, 'stray 999 must be caught');
  console.log('CHECK: stray/AI number detected ->', JSON.stringify(verifyHeadlineNumbers(tampered).stray));

  // 3b) Rounds-to-zero: a near-zero % must NEVER render as "-0%"/"+0%".
  const flatTbl = {
    columns: [
      { id: 'name', label: 'Co', role: 'category', type: 'text' },
      { id: 'p1', label: '2023', role: 'period', type: 'number', periodOrder: 1 },
      { id: 'p2', label: '2024', role: 'period', type: 'number', periodOrder: 2 },
    ],
    rows: [
      { name: 'Acme', p1: 1000000, p2: 1080000 },   // +8%
      { name: 'Globex', p1: 2000000, p2: 1999900 }, // -0.005% -> rounds to zero
    ],
  };
  const flatRoles = { category: 'name', periods: ['p1', 'p2'], total: null, primaryValue: 'p2' };
  const fm = computeMetrics(flatTbl, flatRoles, ['rank_by_growth', 'total_change']);
  const fp = writeHeadline(fm, { focus: ['rank_by_growth', 'total_change'], angle: '' })!;
  assert.ok(!/[+\-]0%/.test(fp.plain), 'no signed-zero %: ' + fp.plain);
  assert.ok(/held flat|essentially|roughly flat|unchanged/.test(fp.plain), 'flat worded: ' + fp.plain);
  assert.ok(verifyHeadlineNumbers(fp).ok, 'flat headline still verified');
  console.log('CHECK rounds-to-zero ->', fp.plain);

  // 3c) BUG 1 — no run-on: an angle with NO end punctuation must still join the
  // first clause with a clean ". " (never "...flatFlorida" or "...flat Florida").
  const noPunctAngle = 'Growth is concentrated in a few large states while the rest stay flat';
  const runon = writeHeadline(metrics, { focus: ['total_change'], angle: noPunctAngle })!;
  assert.ok(runon.plain.startsWith(noPunctAngle + '. '), 'angle terminated with ". ": ' + runon.plain);
  assert.ok(!/[a-z][A-Z]/.test(runon.plain), 'no two words run together: ' + runon.plain);
  console.log('CHECK BUG1 no run-on ->', runon.plain);

  // 3d) BUG 2 — no duplicate fact: rank_by_growth and yoy_pct_change both feature
  // the top % mover (Florida +2.7%); the second clause restates it and is dropped.
  const dup = writeHeadline(metrics, { focus: ['rank_by_growth', 'yoy_pct_change'], angle: '' })!;
  assert.ok(dup.plain.includes('posted the fastest recent growth'), 'rank_by_growth kept: ' + dup.plain);
  assert.ok(!dup.plain.includes('moved most recently'), 'duplicate yoy clause dropped: ' + dup.plain);
  const florida27 = (dup.plain.match(/Florida[^.]*\+2\.7%/g) || []).length;
  assert.strictEqual(florida27, 1, 'Florida +2.7% stated once, not twice: ' + dup.plain);
  console.log('CHECK BUG2 no dup fact ->', dup.plain);

  // 4) Unsupported focus calc skipped; no hint still works.
  const robust = writeHeadline(metrics, { focus: ['acceleration', 'cagr', 'rank_by_value'], angle: '' });
  assert.ok(robust && robust.segments.length, 'still produces a paragraph despite N/A focus');
  const noHint = writeHeadline(metrics, null);
  assert.ok(noHint && noHint.segments.length, 'works with no AI hint at all');
  console.log('CHECK: robust to N/A focus + missing hint');

  console.log('\nALL HEADLINE SELF-CHECKS PASSED');
}
