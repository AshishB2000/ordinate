'use strict';

// The alert RULE dialog, and the three places a rule is born — RENDERER ONLY.
// Classic global-scope <script>: no import/export.
//
// A rule is always created FROM A NUMBER THE USER IS LOOKING AT. That is the
// whole of the design here: there is no "New alert" button anywhere, because a
// blank rule form would ask someone to name a dataset, a column and an
// aggregation from memory. Instead:
//
//   · a KPI card's ⋯ menu            → "Alert me…"
//   · a numeric column's profile     → "Alert me…"
//   · an Insights card               → "Alert me if this happens again"
//
// All three open the SAME dialog, pre-filled from what they were opened on, with
// the current value already computed and shown at the top — so the first thing
// the dialog does is prove it is talking about the number on screen.
//
// EVERY FIGURE IN HERE COMES FROM MAIN. The header value is `dashboard:metric`,
// the Test result is `alerts:test` (which runs the same metric path a real
// firing would), and the message text is composed in src/analysis/alerts.ts. The
// renderer does no arithmetic and no model is involved in any of it.

/** The compares, in tab order. Anomaly last: it is the one with no fields. */
const AL_TABS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'threshold', label: t('common.threshold') },
  { id: 'change', label: t('common.change') },
  { id: 'anomaly', label: t('alerts.anomaly') },
];

const AL_OPS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '<', label: t('alerts.is_below') },
  { value: '<=', label: t('alerts.is_at_or_below') },
  { value: '>', label: t('alerts.is_above') },
  { value: '>=', label: t('alerts.is_at_or_above') },
];

const AL_DIRECTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'down', label: t('alerts.falls_by') },
  { value: 'up', label: t('alerts.rises_by') },
  { value: 'either', label: t('common.moves_by') },
];

const AL_ANOMALY_NOTE =
  t('alerts.ordinate_checks_this_data_after_every');

interface AlertDialogOpts {
  datasetId: string;
  column: string;
  aggregation: string;
  /** What the surface calls this number ("Revenue"), for the header and the name. */
  label?: string;
  /** Filters the source card carries, so the rule watches the same slice it does. */
  filters?: any[];
  /** The dashboard this was created from, so the inbox can offer "Open dashboard". */
  analysisId?: string;
  cardId?: string;
  /** Editing an existing rule rather than creating one. */
  existing?: any;
  /**
   * The saved Metric this rule watches, when the source surface had one.
   *
   * ADDITIVE: `column`/`aggregation` above stay required and stay filled from
   * the metric's own definition, so `alertStore.metricFor` and the whole
   * evaluator are untouched and a rule outlives the metric it was named after.
   * What it buys is the metric's name in the message, and a row in
   * `metric:usage` so deleting the metric warns about this rule.
   */
  metricId?: string;
}

// ── The dialog ───────────────────────────────────────────────────────────────

/**
 * Returns the SAVED rule, or null if cancelled. Saving happens inside (through
 * `alerts:save`) rather than being handed back to the caller: three surfaces
 * open this and none of them wants to learn the storage call.
 */
function openAlertDialog(opts: AlertDialogOpts): Promise<any> {
  return new Promise((resolve) => {
    const existing = opts.existing || {};
    const label = opts.label || opts.column || t('alerts.this_metric');
    let done = false;

    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay';
    overlay.id = 'al-dialog';
    const box = document.createElement('div');
    box.className = 'ws-modal al-modal';

    const title = document.createElement('div');
    title.className = 'ws-modal-title';
    title.textContent = existing.id ? t('alerts.edit_alert') : t('common.alert_me');
    box.appendChild(title);

    // ── The metric summary. The dialog's first job is to prove it is about the
    // number on screen, so the current value is fetched and shown before any
    // field is offered. App-computed in main, like the card's own.
    const summary = document.createElement('div');
    summary.className = 'al-summary';
    const sumLabel = document.createElement('div');
    sumLabel.className = 'al-summary-label';
    sumLabel.textContent = label;
    const sumValue = document.createElement('div');
    sumValue.className = 'al-summary-value tnum';
    sumValue.textContent = '…';
    summary.appendChild(sumLabel);
    summary.appendChild(sumValue);
    box.appendChild(summary);

    let currentValue: number | null = null;

    // ── Tabs ────────────────────────────────────────────────────────────────
    // `.fd-tabs`/`.fd-tab` are the hub's tab strip, first used by the filter
    // dialog. Shared deliberately: one tab strip, one definition.
    let mode = existing.compare || 'threshold';
    const tabs = document.createElement('div');
    tabs.className = 'fd-tabs';
    tabs.setAttribute('role', 'tablist');
    const tabBtns: HTMLButtonElement[] = [];
    AL_TABS.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fd-tab';
      b.setAttribute('role', 'tab');
      b.dataset.mode = t.id;
      b.textContent = t.label;
      b.addEventListener('click', () => {
        mode = t.id;
        paintTabs();
        paintBody();
        syncName();
        clearTest();
      });
      tabBtns.push(b);
      tabs.appendChild(b);
    });
    box.appendChild(tabs);

    function paintTabs(): void {
      tabBtns.forEach((b, i) => {
        const on = AL_TABS[i].id === mode;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }

    const body = document.createElement('div');
    body.className = 'fd-body al-body';
    box.appendChild(body);

    // ── State, one bag per tab ──────────────────────────────────────────────
    let thrOp = (existing.threshold && existing.threshold.op) || '<';
    let thrValue = existing.threshold && existing.threshold.value != null
      ? String(existing.threshold.value) : '';
    let chgPct = existing.change && existing.change.pct != null ? String(existing.change.pct) : '10';
    let chgDir = (existing.change && existing.change.direction) || 'down';
    let chgVs = (existing.change && existing.change.vs) || 'previous_refresh';
    let chgPeriod = (existing.change && existing.change.periodColumn) || '';
    /** True once the user edits the name, after which nothing overwrites it. */
    let nameTouched = Boolean(existing.name);

    const dateColumns = alDateColumns(opts.datasetId);

    function row(text: string): HTMLElement {
      const r = document.createElement('div');
      r.className = 'al-row';
      if (text) {
        const l = document.createElement('span');
        l.className = 'al-row-label';
        l.textContent = text;
        r.appendChild(l);
      }
      return r;
    }

    function paintBody(): void {
      body.innerHTML = '';
      if (mode === 'threshold') {
        const r = row(t('alerts.alert_me_when_this_metric'));
        const op = makeDropdown({ ariaLabel: t('alerts.comparison'), onChange: (v) => { thrOp = v; syncName(); clearTest(); } });
        op.setOptions(AL_OPS.map((o) => ({ value: o.value, label: o.label })), thrOp);
        r.appendChild(op.el);
        const input = document.createElement('input');
        input.className = 'ws-modal-input al-num';
        input.type = 'number';
        input.step = 'any';
        input.value = thrValue;
        // The CURRENT value as the placeholder: the most useful starting point
        // for "below what?" is what it is right now. ROUNDED, because the
        // placeholder is a suggestion the user may type over, and
        // "5194598.7299" is not a number anyone would choose to type.
        input.placeholder = currentValue == null ? t('alerts.a_number') : String(Math.round(currentValue));
        input.setAttribute('aria-label', t('alerts.threshold_value'));
        input.addEventListener('input', () => { thrValue = input.value; syncName(); clearTest(); });
        r.appendChild(input);
        body.appendChild(r);
        return;
      }
      if (mode === 'change') {
        const r = row(t('alerts.alert_me_when_this_metric'));
        const dir = makeDropdown({ ariaLabel: t('common.direction'), onChange: (v) => { chgDir = v; syncName(); clearTest(); } });
        dir.setOptions(AL_DIRECTIONS.map((d) => ({ value: d.value, label: d.label })), chgDir);
        r.appendChild(dir.el);
        const pct = document.createElement('input');
        pct.className = 'ws-modal-input al-num';
        pct.type = 'number';
        pct.min = '0';
        pct.step = 'any';
        pct.value = chgPct;
        pct.setAttribute('aria-label', t('common.percent'));
        pct.addEventListener('input', () => { chgPct = pct.value; syncName(); clearTest(); });
        r.appendChild(pct);
        const unit = document.createElement('span');
        unit.className = 'al-row-label';
        unit.textContent = t('alerts.or_more');
        r.appendChild(unit);
        body.appendChild(r);

        const r2 = row(t('alerts.compared_with'));
        const vs = makeDropdown({ ariaLabel: t('alerts.compared_with_2'), onChange: (v) => { chgVs = v; paintBody(); clearTest(); } });
        vs.setOptions([
          { value: 'previous_refresh', label: t('alerts.the_previous_refresh') },
          { value: 'previous_period', label: t('alerts.the_previous_period') },
        ], chgVs);
        r2.appendChild(vs.el);
        body.appendChild(r2);

        if (chgVs === 'previous_period') {
          const r3 = row(t('alerts.using_the_date_column'));
          if (dateColumns.length === 0) {
            const note = document.createElement('p');
            note.className = 'al-note';
            note.textContent = t('alerts.this_dataset_has_no_date_column');
            body.appendChild(note);
          } else {
            if (!chgPeriod || dateColumns.indexOf(chgPeriod) < 0) chgPeriod = dateColumns[0];
            const col = makeDropdown({ ariaLabel: t('common.date_column'), onChange: (v) => { chgPeriod = v; clearTest(); } });
            col.setOptions(dateColumns.map((c) => ({ value: c, label: c })), chgPeriod);
            r3.appendChild(col.el);
            body.appendChild(r3);
          }
        }
        return;
      }
      const note = document.createElement('p');
      note.className = 'al-note';
      note.textContent = AL_ANOMALY_NOTE;
      body.appendChild(note);
    }

    // ── Name ────────────────────────────────────────────────────────────────
    const nameRow = row(t('common.name'));
    const nameInput = document.createElement('input');
    nameInput.className = 'ws-modal-input al-name';
    nameInput.type = 'text';
    nameInput.value = existing.name || '';
    nameInput.setAttribute('aria-label', t('common.alert_name'));
    nameInput.addEventListener('input', () => { nameTouched = true; });
    nameRow.appendChild(nameInput);
    box.appendChild(nameRow);

    /**
     * Keep the auto-name in step with the condition until the user types their
     * own, then never touch it again. The suggestion is app-composed from the
     * same words the message uses, so a rule reads the same in the table as it
     * does in the banner.
     */
    function syncName(): void {
      if (nameTouched) return;
      const v = Number(thrValue);
      if (mode === 'threshold') {
        const word = AL_OPS.find((o) => o.value === thrOp);
        const target = thrValue === '' ? '…' : fmtWith(v, 'auto');
        nameInput.value = `${label} ${(word ? word.label : 'is').replace(/^is /, '')} ${target}`.trim();
      } else if (mode === 'change') {
        const word = AL_DIRECTIONS.find((d) => d.value === chgDir);
        nameInput.value = `${label} ${(word ? word.label : t('common.moves_by')).replace(/ by$/, '')} ${chgPct || '…'}%`;
      } else {
        nameInput.value = t('alerts.anomalies_in', { label });
      }
    }

    // ── Test + actions ──────────────────────────────────────────────────────
    const test = document.createElement('div');
    test.className = 'al-test';
    test.hidden = true;
    box.appendChild(test);

    function clearTest(): void {
      test.hidden = true;
      test.className = 'al-test';
      test.textContent = '';
    }

    const actions = document.createElement('div');
    actions.className = 'ws-modal-actions al-actions';
    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'btn btn-sm al-test-btn';
    testBtn.textContent = t('common.test');
    const spacer = document.createElement('span');
    spacer.className = 'al-actions-spacer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = t('common.cancel');
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary al-save';
    save.textContent = t('common.save');
    actions.appendChild(testBtn);
    actions.appendChild(spacer);
    actions.appendChild(cancel);
    actions.appendChild(save);
    box.appendChild(actions);

    /** The rule as the fields currently describe it — the one shape both Test and Save send. */
    function draft(): any {
      const rule: any = {
        id: existing.id,
        name: nameInput.value.trim(),
        datasetId: opts.datasetId,
        metric: {
          column: opts.column,
          aggregation: opts.aggregation,
          filters: Array.isArray(opts.filters) && opts.filters.length ? opts.filters : undefined,
          // The surface's word for this number, so the message reads the way
          // the card it is about reads.
          label: opts.label && opts.label !== opts.column ? opts.label : undefined,
          metricId: opts.metricId,
        },
        compare: mode,
        enabled: existing.enabled !== false,
      };
      if (mode === 'threshold') rule.threshold = { op: thrOp, value: Number(thrValue) };
      if (mode === 'change') {
        rule.change = {
          pct: Number(chgPct),
          direction: chgDir,
          vs: chgVs,
          periodColumn: chgVs === 'previous_period' ? chgPeriod : undefined,
        };
      }
      if (opts.analysisId) rule.createdFrom = { analysisId: opts.analysisId, cardId: opts.cardId || '' };
      return rule;
    }

    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      test.hidden = false;
      test.className = 'al-test';
      test.textContent = t('common.checking');
      let r: any;
      try {
        r = await window.hub.testAlertRule(currentProjectId, draft());
      } catch (_) {
        r = { ok: false };
      }
      testBtn.disabled = false;
      if (!r || r.ok === false) {
        test.className = 'al-test is-bad';
        test.textContent = (r && r.error) || t('alerts.fill_the_condition_in_first');
        return;
      }
      // Both halves are app-computed: `fire` is the same decision a real
      // evaluation makes, and `message` is the sentence it would have sent.
      test.className = 'al-test ' + (r.fire ? 'is-fire' : 'is-quiet');
      test.textContent = (r.fire ? t('alerts.would_fire') : t('alerts.would_not_fire')) + r.message;
    });

    function close(rule: any): void {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(rule);
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    }

    cancel.addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey, true);

    save.addEventListener('click', async () => {
      save.disabled = true;
      let r: any;
      try {
        r = await window.hub.saveAlertRule(currentProjectId, draft());
      } catch (_) {
        r = { ok: false };
      }
      save.disabled = false;
      if (!r || r.ok === false) {
        test.hidden = false;
        test.className = 'al-test is-bad';
        test.textContent = (r && r.error) || t('alerts.that_rule_is_not_complete');
        return;
      }
      await alRefreshRules();
      showToast(t('alerts.alert_saved'));
      close(r.rule);
    });

    paintTabs();
    paintBody();
    syncName();
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    nameInput.focus();

    // The header figure, and the threshold placeholder that depends on it. The
    // dialog is usable before this lands — it only ever ADDS information.
    void (async () => {
      try {
        const r: any = await window.hub.computeMetric(
          currentProjectId, opts.datasetId, opts.column, opts.aggregation, opts.filters || [],
        );
        if (done) return;
        currentValue = r && r.ok !== false && r.value != null ? Number(r.value) : null;
        sumValue.textContent = currentValue == null ? '—' : fmtWith(currentValue, 'auto');
        if (mode === 'threshold') paintBody();
      } catch (_) {
        if (!done) sumValue.textContent = '—';
      }
    })();
  });
}

/** The dataset's date columns, for the previous-period picker. */
function alDateColumns(datasetId: string): string[] {
  // The open dataset's columns are already in the renderer (dsExplorer). For any
  // OTHER dataset there is nothing loaded to read, and the previous-refresh
  // comparison — which needs no column at all — is the default for that reason.
  if (typeof expId === 'undefined' || expId !== datasetId) return [];
  if (typeof expColumns === 'undefined' || !Array.isArray(expColumns)) return [];
  return expColumns.filter((c: any) => c && c.type === 'date').map((c: any) => String(c.name));
}

// ── The rule cache, for the KPI card's bell ──────────────────────────────────
//
// A dashboard grid repaints often and a card must not ask main "do I have an
// alert?" on every paint. The rules for the open project are held here, kept
// fresh by the inbox (which is already listening for `alerts:fired`), and read
// synchronously while a card is being built.

let alRules: any[] = [];
let alEvents: any[] = [];

/** Re-read the rules + events for the open project. Safe to call often. */
async function alRefreshRules(): Promise<void> {
  if (!currentProjectId) { alRules = []; alEvents = []; return; }
  try {
    const r: any = await window.hub.listAlerts(currentProjectId);
    alRules = (r && r.ok !== false && Array.isArray(r.rules)) ? r.rules : [];
    alEvents = (r && r.ok !== false && Array.isArray(r.events)) ? r.events : [];
  } catch (_) {
    alRules = [];
    alEvents = [];
  }
}

/** Every enabled rule watching this dataset + column + aggregation. */
function alRulesForMetric(datasetId: string, column: string, aggregation: string): any[] {
  return alRules.filter((r) => r && r.enabled !== false && r.datasetId === datasetId
    && r.metric && r.metric.column === column && r.metric.aggregation === aggregation);
}

/** Is there an UNSEEN event for any of these rules? Drives the accent state. */
function alHasUnseenFor(rules: any[]): boolean {
  if (!rules.length) return false;
  const ids = new Set(rules.map((r) => r.id));
  return alEvents.some((e) => e && !e.seen && ids.has(e.ruleId));
}

/**
 * Put the bell on a metric card's head, if a rule watches it.
 *
 * Does NOTHING when nothing watches this metric — the card must look exactly as
 * it did before alerts existed, which is why this is an absence rather than a
 * dimmed glyph. The bell is accented, and the card marked `al-fired` (which
 * underlines its VALUE — the number is what the rule is about), only while the
 * latest event is unseen: a standing rule is information, a fresh firing is news.
 */
function alAttachCardBell(cardEl: HTMLElement, head: HTMLElement, card: any): void {
  if (!card || card.type !== 'metric') return;
  const m = card.metric || {};
  if (!m.datasetId || !m.column || !m.aggregation) return;
  const rules = alRulesForMetric(m.datasetId, m.column, m.aggregation);
  if (!rules.length) return;
  const unseen = alHasUnseenFor(rules);
  const el = document.createElement('span');
  el.className = 'al-card-bell' + (unseen ? ' is-fired' : '');
  el.title = rules.length === 1 ? rules[0].name : t('alerts.alerts_on_this_metric', { rulesCount: rules.length });
  el.setAttribute('aria-label', el.title);
  el.appendChild(icon('bell', 14));
  head.appendChild(el);
  if (unseen) cardEl.classList.add('al-fired');
}

// ── The three doors ──────────────────────────────────────────────────────────

/**
 * What alerts contribute to a card's ⋯ menu — one item on a metric card, none
 * on any other. A list rather than a boolean so the grid's menu builder stays
 * one `concat` and never grows an `if` about alerts.
 */
function alCardMenuItems(card: any): Array<[string, () => void]> {
  if (!card || card.type !== 'metric') return [];
  return [[t('common.alert_me'), () => { void alertMeFromCard(card); }]];
}

/** A KPI card's ⋯ menu. The card knows its dataset, column, aggregation and label. */
async function alertMeFromCard(card: any): Promise<void> {
  const m = (card && card.metric) || {};
  if (!m.datasetId || !m.column || !m.aggregation) {
    showToast(t('alerts.this_card_has_no_metric_to'));
    return;
  }
  const existing = alRulesForMetric(m.datasetId, m.column, m.aggregation)[0];
  const rule = await openAlertDialog({
    datasetId: String(m.datasetId),
    column: String(m.column),
    aggregation: String(m.aggregation),
    label: m.label || String(m.column),
    // A card that names a metric makes a rule that names the same metric.
    metricId: m.metricId ? String(m.metricId) : undefined,
    // The card's own slice, so the rule watches the number the card shows and
    // not a wider one that happens to share its column.
    filters: typeof effectiveFilters === 'function' ? effectiveFilters() : [],
    analysisId: dashCurrent && dashCurrent.id ? String(dashCurrent.id) : undefined,
    cardId: card && card.id ? String(card.id) : undefined,
    existing,
  });
  // Repaint so the new bell appears without a reload.
  if (rule && typeof renderDashGrid === 'function') renderDashGrid();
}

/** The dataset page's column profile — numeric columns only. */
async function alertMeFromColumn(): Promise<void> {
  if (typeof dsProfileCol !== 'number' || dsProfileCol < 0) return;
  const col = expColumns[dsProfileCol];
  if (!col || !expId) return;
  if (col.type !== 'number') {
    showToast(t('alerts.alerts_watch_a_number_pick_a'));
    return;
  }
  await openAlertDialog({
    datasetId: String(expId),
    column: String(col.name),
    // `sum` is the aggregation a KPI card defaults to and the one "revenue drops
    // 10%" means; the dialog is one field from any other.
    aggregation: 'sum',
    label: String(col.name),
  });
}

/**
 * An Insights card's "Alert me if this happens again".
 *
 * An insight already names a dataset and a column — that IS the rule's metric —
 * and "again" is a change, so the dialog opens on the Change tab with the
 * insight's own direction already chosen.
 */
async function alertMeFromInsight(ins: any): Promise<void> {
  if (!ins || !ins.datasetId || !ins.column) {
    showToast(t('common.that_insight_is_not_about_one'));
    return;
  }
  const down = Number(ins.facts && ins.facts.pctChange) < 0;
  await openAlertDialog({
    datasetId: String(ins.datasetId),
    column: String(ins.column),
    aggregation: 'sum',
    label: String(ins.column),
    existing: {
      compare: 'change',
      change: { pct: 10, direction: down ? 'down' : 'up', vs: 'previous_refresh' },
    },
  });
}
