'use strict';

// TYPED FILTERS — applying what was typed, from any of its three doors: the
// filter bar's box (filterType.ts), ⌘K's `@` mode (palette.ts) and the dock's
// "filter this to …" (dock.ts). One parser, one apply.
//
// A chip becomes what a user could have made BY HAND, so everything
// downstream is unchanged:
//   • a CONTROL, when the open page has one on that column that can hold it —
//     a multi-select takes `=`/`in`, a dropdown `=`, a date range a period.
//     Its live selection is set exactly as picking in it would set it.
//   • otherwise a SELECTION step (dashSelection.ts) — the strip a map click or
//     a navigation's carry already uses, so it shows as a removable chip and
//     joins effectiveFilters() for every card.
// Both are reader state: never saved, allowed on a read-only dashboard.
// A new selection step replaces an old one on the same column and kind
// ("west" after "east" moves the selection rather than intersecting to none).
//
// Classic global-scope renderer <script>: no import/export. Loads after
// filterType.js (ftParse) and dashSelection.js.

/** Same operator family: a new `in` replaces an old `=`, a new `≠` an old `not in`. */
function ftOpFamily(op: string): string {
  if (op === '=' || op === 'in') return 'is';
  if (op === '!=' || op === 'not in') return 'not';
  return op;
}

/** The control on the open page that can hold this chip, if any. */
function ftControlFor(chip: any): any {
  if (chip.negated || typeof dashBarControls !== 'function') return null;
  const step = chip.steps[0];
  return dashBarControls().find((c: any) => {
    const k = c.control && c.control.kind;
    if (!c.control || c.control.column !== chip.column) return false;
    if (chip.kind === 'date') return k === 'date_range';
    if (chip.kind !== 'value') return false;
    return k === 'multi' || (k === 'dropdown' && step.op === '=');
  }) || null;
}

/** The control's own state shape for a chip — what its widget writes when picked. */
function ftControlValue(card: any, chip: any): any {
  const step = chip.steps[0];
  const kind = card.control.kind;
  if (kind === 'multi') return { values: step.op === 'in' ? step.values.slice() : [step.value] };
  if (kind === 'dropdown') return { value: step.value };
  const p = step.period || {};
  if (p.preset && p.preset !== 'custom') return p.n ? { preset: p.preset, n: p.n } : { preset: p.preset };
  return { from: p.from, to: p.to };
}

/** Apply chips to the open dashboard. Returns the labels of what was applied. */
function ftApplyChips(chips: any[]): string[] {
  if (!dashCurrent || !Array.isArray(chips)) return [];
  const labels: string[] = [];
  let sel = dashSel.slice();
  for (const chip of chips) {
    const steps = chip && Array.isArray(chip.steps) ? chip.steps : [];
    if (!steps.length) continue;
    labels.push(String(chip.label));
    const card = ftControlFor(chip);
    if (card) { controlState.set(card.id, ftControlValue(card, chip)); continue; }
    sel = sel.filter((s) => !steps.some((n: any) => n.column === s.column && ftOpFamily(n.op) === ftOpFamily(s.op)));
    sel = sel.concat(steps.map((s: any) => ({ ...s })));
  }
  if (!labels.length) return labels;
  dashSel = sel;
  renderDashSelStrip();
  renderDashGrid();
  return labels;
}

/** Whether a dashboard is on screen to filter — the editor, read-only or not. */
function ftDashboardOpen(): boolean {
  const ed = document.getElementById('dash-editor');
  return currentSection === 'analyses' && !!dashCurrent && !!dashCurrent.id && !!ed && !ed.hidden;
}

// ── ⌘K `@west` ───────────────────────────────────────────────────────────────

/** `@…` with a dashboard open: the typed filter's chips as palette rows. [] otherwise. */
async function ftPaletteGroups(q: string): Promise<CpGroup[]> {
  if (!q.trim() || !ftDashboardOpen()) return [];
  const res = await ftParse(q, {});
  if (!res || !res.ok || !Array.isArray(res.chips) || !res.chips.length) return [];
  const words = (res.unknown || []).length ? t('filterTypeApply.not_recognised', { p0: res.unknown.join(', ') }) : '';
  const rows: CpRow[] = res.chips.map((chip: any) => ({
    title: chip.label,
    meta: t('filterTypeApply.filter_match', { p0: (FT_MATCH_WORD[chip.match] || chip.match), words }),
    icon: 'filter',
    run: () => { paletteClose(); ftApplyAndTell([chip]); },
  }));
  if (res.chips.length > 1) {
    rows.unshift({
      title: t('filterTypeApply.apply_all_filters', { chipsCount: res.chips.length }),
      meta: res.chips.map((c: any) => c.label).join(' · '),
      icon: 'filter',
      run: () => { paletteClose(); ftApplyAndTell(res.chips); },
    });
  }
  return [{ label: t('common.filter_2', { p0: (dashCurrent.name || t('common.this_dashboard')) }), rows }];
}

function ftApplyAndTell(chips: any[]): void {
  const applied = ftApplyChips(chips);
  if (applied.length) showToast(t('common.filtered_to', { p0: applied.join(' · ') }));
}

// ── The dock: "filter this to furniture" ─────────────────────────────────────

const FT_DOCK_RE = /^\s*filter\s+(?:this\s+)?(?:to|by)\b\s*([\s\S]*)$/i;

/**
 * Answer "filter this to …" / "filter to …" / "filter by …" on an open
 * dashboard HERE — parsed and applied by the app, with no model call and no
 * network — and say what was done in an app-written bubble. Returns false for
 * anything else, which the dock then asks the model as usual.
 */
async function ftDockFilter(question: string): Promise<boolean> {
  const m = FT_DOCK_RE.exec(question);
  if (!m || !ftDashboardOpen()) return false;
  xpAppendBubble('user', question, undefined, 'dk-messages');
  const res = await ftParse(m[1], {});
  let text: string;
  if (!res || !res.ok) {
    text = t('filterTypeApply.i_could_not_read_the_values');
  } else {
    const applied = ftApplyChips(res.chips);
    text = applied.length
      ? t('filterTypeApply.filtered_to', { p0: (dashCurrent.name || t('common.this_dashboard')), p1: applied.join(' · ') })
      : t('filterTypeApply.nothing_there_matched_a_value_date');
    if (res.unknown && res.unknown.length) text += t('filterTypeApply.not_recognised_2', { p0: res.unknown.map((w: string) => '“' + w + '”').join(', ') });
  }
  xpAppendBubble('assistant', text, { note: t('filterTypeApply.applied_by_the_app_no_model') }, 'dk-messages');
  xpScrollToBottom('dk-messages');
  return true;
}
