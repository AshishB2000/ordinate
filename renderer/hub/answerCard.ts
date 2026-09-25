// ANSWER CARDS — the renderer half of "the Assistant answers with charts".
//
// An assistant turn that carries an `answer` spec (src/ai/answerSpec.ts) is
// drawn as a card above its narration: the title and the filters in force, the
// headline figures, a 320×180 chart, the app's caption, and four actions — Save
// as visual, Add to dashboard, Open in builder, Show table — then the follow-up
// chips. Every figure on the card comes from `answer:card` (src/ipc/answers.ts),
// recomputed from the stored spec on every render; this file formats nothing
// and derives nothing. With no model configured the turn has no prose, and the
// card shows the app's facts as bullet points instead — the same content.
//
// "Explain" (every visual's and every dashboard tile's ⋯ menu) lands here too:
// main builds the tile's card into a NEW conversation and this file opens it.
//
// Classic global-scope script — NO import/export. textContent only: a column
// name or a category value is user data and never markup.

function ansEl<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Tear down every chart an answer card drew inside `root` before it leaves the DOM. */
function ansTeardown(root: Element | null): void {
  if (!root) return;
  root.querySelectorAll('.ans-chart').forEach((area) => {
    const inst = chartInstances.get(area);
    if (inst) (Array.isArray(inst) ? inst : [inst]).forEach((c: any) => { try { c.destroy(); } catch (_) { /* gone */ } });
    chartInstances.delete(area);
  });
}

/**
 * Mount the card for one stored answer turn, ABOVE its narration. Called by
 * askCore's xpAppendBubble for any assistant turn carrying `answer`.
 */
function ansMount(row: HTMLElement, bubble: HTMLElement, turn: any): void {
  const card = ansEl('div', 'ans-card is-loading');
  card.setAttribute('aria-busy', 'true');
  card.appendChild(ansEl('div', 'ans-title', turn.answer && turn.answer.title ? String(turn.answer.title) : 'Answer'));
  const sk = skelBlock('ans-skel');
  card.appendChild(sk);
  row.insertBefore(card, bubble);
  const narrated = typeof turn.text === 'string' && turn.text.trim() !== '';
  if (!narrated) bubble.hidden = true;
  void (async () => {
    let res: any = null;
    try {
      res = currentProjectId ? await window.hub.answerCard(currentProjectId, turn.answer) : null;
    } catch (_) {
      res = null;
    }
    card.classList.remove('is-loading');
    card.removeAttribute('aria-busy');
    sk.remove();
    if (!res || res.ok !== true) {
      card.classList.add('is-error');
      card.appendChild(ansEl('div', 'ans-note', res && res.reason ? String(res.reason) : 'This answer could not be drawn.'));
      bubble.hidden = !narrated;
      return;
    }
    ansRender(card, res, narrated);
  })();
}

function ansRender(card: HTMLElement, res: any, narrated: boolean): void {
  card.textContent = '';
  const head = ansEl('div', 'ans-head');
  head.appendChild(ansEl('div', 'ans-title', String(res.title || 'Answer')));
  const meta = ansEl('div', 'ans-meta');
  meta.appendChild(ansEl('span', 'ans-meta-ds', String(res.datasetName || '')));
  (Array.isArray(res.filterLabels) ? res.filterLabels : []).forEach((f: string) => {
    meta.appendChild(ansEl('span', 'ans-filter', String(f)));
  });
  head.appendChild(meta);
  card.appendChild(head);

  const kpis = Array.isArray(res.headline) ? res.headline : [];
  if (kpis.length) {
    const row = ansEl('div', 'ans-kpis');
    kpis.forEach((k: any) => {
      const cell = ansEl('div', 'ans-kpi');
      cell.appendChild(ansEl('div', 'ans-kpi-value', String(k.display)));
      cell.appendChild(ansEl('div', 'ans-kpi-label', String(k.label)));
      row.appendChild(cell);
    });
    card.appendChild(row);
  }

  // .cv-viz-area so the dock's existing resize nudge reaches this chart too.
  // 320×180 (hub.css .ans-chart), narrowing with a dock dragged thinner.
  const area = ansEl('div', 'ans-chart cv-viz-area');
  card.appendChild(area);
  if (res.caption) card.appendChild(ansEl('div', 'ans-caption', String(res.caption)));
  (Array.isArray(res.notes) ? res.notes : []).forEach((n: string) => card.appendChild(ansEl('div', 'ans-note', String(n))));

  if (!narrated && Array.isArray(res.bullets) && res.bullets.length) {
    const ul = ansEl('ul', 'ans-facts');
    res.bullets.forEach((b: string) => ul.appendChild(ansEl('li', '', String(b))));
    card.appendChild(ul);
  }

  const tableWrap = ansEl('div', 'ans-table-wrap');
  tableWrap.hidden = true;
  card.appendChild(tableWrap);

  const actions = ansEl('div', 'ans-actions');
  const btn = (label: string, primary: boolean, run: (b: HTMLButtonElement) => void): HTMLButtonElement => {
    const b = ansEl('button', primary ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm', label);
    b.type = 'button';
    b.addEventListener('click', () => run(b));
    actions.appendChild(b);
    return b;
  };
  btn('Save as visual', true, (b) => { void ansSave(res, b); });
  btn('Add to dashboard', false, (b) => { void ansAddToDashboard(res, b); });
  btn('Open in builder', false, () => { void ansOpenInBuilder(res); });
  btn('Show table', false, (b) => {
    tableWrap.hidden = !tableWrap.hidden;
    b.textContent = tableWrap.hidden ? 'Show table' : 'Hide table';
    if (!tableWrap.hidden && !tableWrap.firstChild) {
      const t = ansEl('table', 'cv-table ans-table');
      tableWrap.appendChild(t);
      buildDataTable(t, res.data);
    }
  });
  card.appendChild(actions);

  const chips = Array.isArray(res.chips) ? res.chips : [];
  if (chips.length) {
    const row = ansEl('div', 'ans-chips');
    chips.forEach((c: any) => {
      const chip = ansEl('button', 'ans-chip', String(c.label));
      chip.type = 'button';
      chip.addEventListener('click', () => { void ansRerun(c.spec, String(c.label), chip); });
      row.appendChild(chip);
    });
    card.appendChild(row);
  }

  // Mounted (it is already in the document), THEN drawn: buildChart reads its
  // theme colours off the canvas, and a detached canvas reads '' for all of them.
  renderVizInArea(area, res.data, res.chartType, null, '');
}

/** The saveable visual an answer describes — its own spec, its resolved filters. */
function ansVisual(res: any): { datasetId: string; name: string; chartType: string; encoding: any; filters: any[] } {
  const s = res.spec || {};
  const encoding: any = { category: s.category, values: s.measures || [] };
  if (s.series) encoding.series = s.series;
  if (s.grain) encoding.grain = s.grain;
  return {
    datasetId: String(s.datasetId),
    name: truncate(String(res.title || 'Answer'), 60),
    chartType: String(res.chartType || 'column'),
    encoding,
    filters: Array.isArray(res.steps) ? res.steps : [],
  };
}

async function ansSaveVisual(res: any): Promise<string> {
  if (!currentProjectId) return '';
  const v = ansVisual(res);
  let saved: any = null;
  try {
    saved = await window.hub.saveVisual({
      projectId: currentProjectId, datasetId: v.datasetId, name: v.name, chartType: v.chartType,
      encoding: v.encoding, overrides: {}, filters: v.filters,
    });
  } catch (_) {
    saved = null;
  }
  return saved && saved.ok !== false && saved.id ? String(saved.id) : '';
}

async function ansSave(res: any, b: HTMLButtonElement): Promise<void> {
  b.disabled = true;
  const id = await ansSaveVisual(res);
  if (!id) {
    b.disabled = false;
    showToast('Could not save the visual.');
    return;
  }
  b.textContent = 'Saved';
  showToast('Saved as visual — find it in Visuals.');
}

/**
 * Onto the dashboard being edited when there is one; otherwise onto a NEW
 * dashboard, which then opens — the chart always lands somewhere visible.
 */
async function ansAddToDashboard(res: any, b: HTMLButtonElement): Promise<void> {
  b.disabled = true;
  const page = typeof dashCurrentPage === 'function' ? dashCurrentPage() : null;
  if (page && !dashReadOnly) {
    const id = await ansSaveVisual(res);
    if (id) {
      pushCard({ id: dashUuid(), type: 'visual', visualId: id, layout: { ...dashFindSlot(dashCards(), 6, 6), w: 6, h: 6 } });
      showToast('Added to the dashboard.');
      return;
    }
  } else {
    const v = ansVisual(res);
    if (await dkTurnIntoAnalysis(v.datasetId, v.name, v.chartType, v.encoding, v.filters)) return;
  }
  b.disabled = false;
  showToast('Could not add it to a dashboard.');
}

async function ansOpenInBuilder(res: any): Promise<void> {
  const v = ansVisual(res);
  selectSection('visuals');
  await openVisualBuilder(v.datasetId);
  await onDatasetChange(v.datasetId, Object.assign({}, v.encoding, { filters: v.filters }));
  applySuggestedEncoding(v.encoding, v.chartType);
}

/** A follow-up chip: the chip's own spec, recomputed by the app, appended to this conversation. */
async function ansRerun(spec: any, label: string, chip: HTMLButtonElement): Promise<void> {
  if (!currentProjectId) return;
  chip.disabled = true;
  chip.classList.add('is-busy');
  let r: any = null;
  try {
    r = await window.hub.answerRerun(currentProjectId, dkThreadId, spec, label);
  } catch (_) {
    r = null;
  }
  chip.disabled = false;
  chip.classList.remove('is-busy');
  if (!r || !r.ok) {
    showToast(r && r.reason ? String(r.reason) : 'Could not run that follow-up.');
    return;
  }
  if (r.threadId) dkThreadId = String(r.threadId);
  xpRenderTurns(r.turns, 'dk-messages');
}

/**
 * "Explain" — the app assembles the chart's facts, main writes them into a new
 * conversation (narrated when a model is configured, bullet points when not),
 * and the dock opens on it.
 */
async function ansExplain(target: { visualId?: string; tile?: any }): Promise<void> {
  if (!currentProjectId) return;
  let r: any = null;
  try {
    r = await window.hub.answerExplain(currentProjectId, target);
  } catch (_) {
    r = null;
  }
  if (!r || !r.ok || !r.threadId) {
    showToast(r && r.reason ? String(r.reason) : 'Could not explain that chart.');
    return;
  }
  dkSetOpen(true);
  await dkOpenThread(String(r.threadId));
}

/**
 * The dashboard card ⋯ items: Explain for a visual card. Same provider shape as
 * alCardMenuItems. The tile is explained AS DRAWN — its snapshot or saved
 * visual, under the dashboard's live filters (the same merge dashGrid computes
 * the figure with), so the facts are the numbers on screen.
 */
function ansCardMenuItems(card: any): Array<[string, () => void]> {
  if (!card || card.type !== 'visual') return [];
  return [['Explain', () => {
    void (async () => {
      const r = await resolveCardVisual(card);
      if (!r) { showToast('This chart cannot be explained.'); return; }
      const v = r.visual;
      await ansExplain({ tile: {
        datasetId: v.datasetId, encoding: v.encoding, chartType: v.chartType,
        name: dashCardTitle(card) === 'Visual' ? v.name : dashCardTitle(card),
        filters: mergeDashFilters(effectiveFilters(), v.filters),
      } });
    })();
  }]];
}
