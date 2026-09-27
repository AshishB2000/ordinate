'use strict';

// The Share policy at every door data leaves by — ONE helper, not a copy per
// dialog. Each export surface asks it two things:
//
//   pvShareNote(path, ids)   the line its dialog shows: "2 sensitive columns
//                            will be masked · Change". Empty (hidden) when
//                            nothing on the way out is marked sensitive.
//   pvShareGate(path, ids)   whether the export may run. Under 'include' that
//                            is an explicit confirmation naming the columns;
//                            under mask/drop it always may (a surface with no
//                            dialog gets the line as a toast instead).
//
// The masking itself is MAIN's (app/sharePolicy.ts): the salt never reaches a
// renderer, so the chart data an export draws comes from pvVisualData, which
// asks `visual:data` with the share path and gets tokens back.
//
// Classic global-scope renderer <script>: no import/export.

type PvPath = 'export' | 'report' | 'publish' | 'bundle';

async function pvSummary(path: PvPath, datasetIds: string[] | null): Promise<any> {
  if (!currentProjectId || !window.hubPrivacy) return null;
  try {
    const r = await window.hubPrivacy.summary(currentProjectId, path, datasetIds);
    return r && r.ok ? r : null;
  } catch (_) {
    return null;
  }
}

/** "email (Customers), card_number (Customers)" — the columns a line is about. */
function pvColumnList(s: any, max = 6): string {
  const cols: any[] = Array.isArray(s && s.columns) ? s.columns : [];
  const names = cols.slice(0, max).map((c) => (c.datasetName ? `${c.column} (${c.datasetName})` : String(c.column)));
  return names.join(', ') + (cols.length > max ? `, and ${cols.length - max} more` : '');
}

/**
 * Settings → Privacy. From inside a dialog the dialog is closed first, so the
 * policy editor is not opened underneath it: the modal dialogs listen for
 * Escape on the document, the drill panel has its own Close.
 */
function pvOpenPolicy(from?: Element | null): void {
  const drill = from ? from.closest('.drill-backdrop') : null;
  if (drill) (drill.querySelector('.js-drill-close') as HTMLElement | null)?.click();
  else if (from && from.closest('.ws-modal-overlay, .export-backdrop, .pv-confirm-overlay')) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  }
  void showSettingsPanel('privacy');
}

/** The dialog line. Returned at once and filled when the summary arrives. */
function pvShareNote(path: PvPath, datasetIds: string[] | null): HTMLElement {
  const el = document.createElement('div');
  el.className = 'pv-share-note';
  el.hidden = true;
  el.setAttribute('role', 'status');
  void pvSummary(path, datasetIds).then((s) => {
    if (!s || !s.count) return;
    el.classList.add('pv-share-note--' + s.action);
    el.appendChild(icon('shield', 14));
    const text = document.createElement('span');
    text.className = 'pv-share-text';
    text.textContent = s.line;
    text.title = pvColumnList(s, 20);
    el.appendChild(text);
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'pv-link';
    link.textContent = 'Change';
    link.setAttribute('aria-label', 'Change the share policy');
    link.addEventListener('click', () => pvOpenPolicy(link));
    el.appendChild(link);
    el.hidden = false;
  });
  return el;
}

/** Mount (or replace) the line inside `host`, before `before` (default: its last child; null appends). */
function pvMountShareNote(host: Element | null, path: PvPath, datasetIds: string[] | null, before?: Element | null): void {
  if (!host) return;
  const old = host.querySelector(':scope > .pv-share-note');
  if (old) old.remove();
  host.insertBefore(pvShareNote(path, datasetIds), before === undefined ? host.lastElementChild : before);
}

/** The include-confirmation. Resolves true only on the explicit Include button. */
function pvConfirmInclude(s: any): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay pv-confirm-overlay';
    const box = document.createElement('div');
    box.className = 'ws-modal pv-confirm';
    const head = document.createElement('div');
    head.className = 'pv-confirm-head';
    head.appendChild(icon('shield', 18));
    const title = document.createElement('div');
    title.className = 'ws-modal-title';
    title.textContent = 'Include sensitive data?';
    head.appendChild(title);
    const body = document.createElement('p');
    body.className = 'pv-confirm-body';
    body.textContent = `${s.line}: ${pvColumnList(s)}. Anyone who receives this will see their values.`;
    const note = document.createElement('p');
    note.className = 'pv-confirm-note';
    note.textContent = 'The share policy for this project says to include them. You can mask or drop them instead.';
    const actions = document.createElement('div');
    actions.className = 'ws-modal-actions';
    const change = document.createElement('button');
    change.type = 'button';
    change.className = 'btn pv-confirm-change';
    change.textContent = 'Change policy';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-primary';
    ok.textContent = 'Include and export';

    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
    const close = (v: boolean): void => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (a11y) a11y.release();
      resolve(v);
    };
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      else if (a11y) a11y.onTabKey(e);
    }
    change.addEventListener('click', () => { close(false); void showSettingsPanel('privacy'); });
    cancel.addEventListener('click', () => close(false));
    ok.addEventListener('click', () => close(true));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey, true);

    actions.appendChild(change);
    actions.appendChild(cancel);
    actions.appendChild(ok);
    box.appendChild(head);
    box.appendChild(body);
    box.appendChild(note);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    a11y = makeModalAccessible(box, 'Include sensitive data?', cancel);
  });
}

/**
 * May this export run? `noted` = the surface already shows pvShareNote, so a
 * mask/drop needs no toast on top of it.
 */
async function pvShareGate(path: PvPath, datasetIds: string[] | null, opts: { noted?: boolean } = {}): Promise<boolean> {
  const s = await pvSummary(path, datasetIds);
  if (!s || !s.count) return true;
  if (s.action === 'include') return pvConfirmInclude(s);
  if (!opts.noted) showToast(s.line, { action: { label: 'Change', onClick: () => pvOpenPolicy(null) } });
  return true;
}

/**
 * `visual:data` for an answer that is about to leave the app. No fallback to
 * the unshaped call: a missing bridge means the policy cannot be applied, and
 * an export that silently skipped it would be the one leak this exists to stop.
 */
async function pvVisualData(projectId: string, datasetId: string, encoding: any, filters: any, params: any, share: PvPath, analytics?: any): Promise<any> {
  if (!window.hubPrivacy) return { ok: false, error: 'The share policy could not be applied.' };
  return window.hubPrivacy.visualData(projectId, datasetId, encoding, filters, params, share, analytics);
}

/**
 * Chart data the renderer already holds (Copy data, a pivot's CSV), shaped by
 * the policy before it leaves. `src` names the dataset it was drawn from; a
 * chart with none (a screenshot capture) has no policy to apply. null = do not
 * export (declined, or hidden by the policy — the toast says which).
 */
async function pvShareData(src: { projectId?: string; datasetId?: string; encoding?: any } | null, data: any, path: PvPath): Promise<any> {
  if (!src || !src.datasetId || !src.projectId) return data;
  if (!(await pvShareGate(path, [src.datasetId]))) return null;
  let r: any = null;
  try {
    r = window.hubPrivacy ? await window.hubPrivacy.shareReply(src.projectId, src.datasetId, src.encoding, { ok: true, data }, path) : null;
  } catch (_) {
    r = null;
  }
  if (!r || r.ok === false || !r.data) {
    showToast((r && r.error) || 'The share policy could not be applied.');
    return null;
  }
  return r.data;
}

/** Every dataset a dashboard's (or a report's analysis') cards draw from. */
async function pvCardDatasetIds(analysis: any): Promise<string[]> {
  const ids = new Set<string>();
  const pages: any[] = (analysis && (analysis.pages || analysis.sheets)) || [];
  for (const page of pages) {
    for (const card of (page && Array.isArray(page.cards) ? page.cards : [])) {
      if (card.visual && card.visual.datasetId) ids.add(String(card.visual.datasetId));
      else if (card.visualId && currentProjectId) {
        try {
          const v = await window.hub.getVisual(currentProjectId, card.visualId);
          if (v && v.datasetId) ids.add(String(v.datasetId));
        } catch (_) { /* a removed visual exports nothing */ }
      }
      if (card.metric && card.metric.datasetId) ids.add(String(card.metric.datasetId));
    }
  }
  return [...ids];
}
