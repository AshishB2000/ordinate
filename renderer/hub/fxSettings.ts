'use strict';

// Settings → General → CURRENCY: the open project's target currency and where
// its exchange rates come from — the bundled sample (always labelled "Sample
// rates, not live") or any dataset of the project (an input table, a CSV, a
// connection) mapped to date / from / to / rate. Its own group, mounted after
// Formats at load, so settingsFormats.ts is not edited. Uses that file's row
// builders (sfEl, sfRow). Classic global-scope renderer <script>.

/** A rate dataset picked but not yet fully mapped: its id and the columns chosen so far. */
let fxPending: { datasetId: string; map: Record<string, string> } | null = null;
let fxDatasets: any[] = [];
let fxPendingCols: any[] = [];
let fxSettingsSeq = 0;

const FX_ROLES: Array<[string, string, RegExp]> = [
  ['date', 'Date', /date|day|as.?of|on$/i],
  ['from', 'From', /^from|base|source/i],
  ['to', 'To', /^to$|^to[ _]|quote|target|counter/i],
  ['rate', 'Rate', /rate|fx|price|value/i],
];

/** Each role's best-guess column: by name, then by type. */
function fxGuessMap(cols: any[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const [role, , re] of FX_ROLES) {
    const want = role === 'date' ? 'date' : role === 'rate' ? 'number' : 'text';
    const hit = cols.find((c) => !used.has(c.name) && c.type === want && re.test(c.name))
      || (role === 'date' || role === 'rate' ? cols.find((c) => !used.has(c.name) && c.type === want) : undefined);
    if (hit) { out[role] = hit.name; used.add(hit.name); }
  }
  return out;
}

async function fxPickSource(datasetId: string): Promise<void> {
  if (!currentProjectId || !window.hubFx) return;
  if (!datasetId) {
    fxPending = null;
    fxTake(await window.hubFx.set(currentProjectId, { source: null }));
    return;
  }
  let meta: any = null;
  try { meta = await window.hub.getDatasetMeta(currentProjectId, datasetId); } catch (_) { meta = null; }
  const cols = meta && Array.isArray(meta.columns) ? meta.columns : [];
  fxPendingCols = cols;
  fxPending = { datasetId, map: fxGuessMap(cols) };
  await fxSaveIfMapped();
}

async function fxSaveIfMapped(): Promise<void> {
  if (!fxPending || !currentProjectId) { fxPaintSettings(); return; }
  const m = fxPending.map;
  if (m.date && m.from && m.to && m.rate) {
    const r = await window.hubFx.set(currentProjectId, { source: { datasetId: fxPending.datasetId, ...m } });
    fxPending = null;
    fxTake(r);
  } else {
    fxPaintSettings();
  }
}

function fxSettingsHost(): HTMLElement | null {
  let host = document.getElementById('stp-currency');
  if (host) return host;
  const formats = document.getElementById('stp-formats');
  if (!formats) return null;
  host = sfEl('div', 'stp-group fx-settings');
  host.id = 'stp-currency';
  formats.after(host);
  return host;
}

async function fxPaintSettings(): Promise<void> {
  const host = fxSettingsHost();
  if (!host) return;
  const seq = ++fxSettingsSeq;
  const head = sfEl('div', 'stp-subhead');
  head.appendChild(sfEl('div', 'stp-subhead-t', 'Currency'));
  head.appendChild(sfEl('div', 'stp-subhead-d',
    'Money columns convert to one currency at each row\'s date, on every metric and chart in this project. Declare a column\'s currency from its profile on the Data page.'));
  if (!currentProjectId || !fxState) {
    host.innerHTML = '';
    host.appendChild(head);
    host.appendChild(sfEl('p', 'fx-empty', 'Open a project to set its currency.'));
    return;
  }
  try {
    const list = await window.hub.listDatasets(currentProjectId);
    fxDatasets = Array.isArray(list) ? list : [];
  } catch (_) { fxDatasets = []; }
  if (seq !== fxSettingsSeq) return;
  host.innerHTML = '';
  host.appendChild(head);
  const s = fxState.settings;

  const targets: Array<[string, string]> = [['', 'Workspace currency (' + fxState.workspaceCurrency + ')']];
  (fxState.codes || []).forEach((c: string) => targets.push([c, c + ' — ' + OrdFormat.currencySymbol(c)]));
  const tSel = fxSelect(targets, s.target || '', 'Target currency', async (v) => {
    fxTake(await window.hubFx.set(currentProjectId as string, { target: v || null }));
  });
  tSel.id = 'stp-fx-target';
  host.appendChild(sfRow('Target currency', 'What every converted figure is shown in. A dashboard can pick its own from its header.', tSel));

  const srcId = fxPending ? fxPending.datasetId : (s.source ? s.source.datasetId : '');
  const sources: Array<[string, string]> = [['', 'Sample rates (built in)']];
  fxDatasets.forEach((d: any) => sources.push([d.id, d.name]));
  const sSel = fxSelect(sources, srcId, 'Exchange rates', (v) => { void fxPickSource(v); });
  sSel.id = 'stp-fx-source';
  host.appendChild(sfRow('Exchange rates', 'A table of date, from-currency, to-currency and rate — an input table, a CSV or a connection. The nearest earlier rate applies; a missing pair goes via USD.', sSel));

  if (srcId) {
    const map = fxPending ? fxPending.map : { date: s.source.date, from: s.source.from, to: s.source.to, rate: s.source.rate };
    const cols = fxPending ? fxPendingCols : [];
    const names: string[] = cols.length ? cols.map((c: any) => c.name) : Object.values(map) as string[];
    const grid = sfEl('div', 'fx-map');
    for (const [role, label] of FX_ROLES) {
      const opts: Array<[string, string]> = [['', 'Choose…']].concat(names.map((n) => [n, n] as [string, string])) as Array<[string, string]>;
      const sel = fxSelect(opts, map[role as keyof typeof map] || '', label + ' column', (v) => {
        fxPending = fxPending || { datasetId: srcId, map: { ...map } };
        fxPending.map[role] = v;
        if (!fxPendingCols.length) fxPendingCols = names.map((n) => ({ name: n }));
        void fxSaveIfMapped();
      });
      sel.dataset.role = role;
      const l = sfEl('label', 'fx-map-cell');
      l.appendChild(sfEl('span', 'fx-map-k', label));
      l.appendChild(sel);
      grid.appendChild(l);
    }
    const row = sfRow('Columns', fxPending ? 'Pick the column for each — saved once all four are set.' : 'Which column holds what.', grid);
    host.appendChild(row);
  }

  if (!s.source && !fxPending) {
    const box = sfEl('div', 'fx-sample');
    box.id = 'stp-fx-sample';
    box.appendChild(sfEl('span', 'fx-chip fx-chip-sample', fxState.sample.label));
    box.appendChild(sfEl('p', 'fx-sample-note',
      fxState.sample.note + ' Covers ' + fxState.sample.currencies.join(', ') + ', ' + fxState.sample.from + ' to ' + fxState.sample.to + '.'));
    host.appendChild(box);
  }
}

// Repaint when the General pane is shown — the project may have changed since.
(function fxInitSettings(): void {
  const pane = document.querySelector('.settings-pane[data-cat="general"]') as HTMLElement | null;
  const panel = document.getElementById('settings-panel');
  if (!pane) return;
  fxSettingsHost();
  const shown = (): boolean => !pane.hidden && !!panel && panel.style.display !== 'none' && panel.style.display !== '';
  const obs = new MutationObserver(() => { if (shown()) void fxPaintSettings(); });
  obs.observe(pane, { attributes: true, attributeFilter: ['hidden'] });
  if (panel) obs.observe(panel, { attributes: true, attributeFilter: ['style'] });
})();
