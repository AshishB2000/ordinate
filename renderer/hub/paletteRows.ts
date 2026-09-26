'use strict';

// What goes IN the palette's rows — the other half of palette.ts, which is the
// box itself (open, close, keyboard, paint).
//
// Split by job rather than by size (.claude/rules/file-size.md): everything
// here answers "what should this row say and do", and nothing here knows the
// overlay exists beyond closing it before it acts.
//
// Nothing invents a figure or asks a model. A "Chart revenue by region" row is
// built from the dataset's own column list and opens the builder preconfigured;
// a record row opens through the SAME function the section's own list uses.
//
// Classic global-scope renderer <script>: no import/export. Loads before
// palette.js.

/** Enough suggestions to be a hint, few enough not to be a menu. */
const CP_MAX_SUGGEST = 3;

interface CpRecord {
  kind: string;
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  meta: string;
  type: string;
  /** Catalog tags, coloured (src/app/catalogIndex.ts). */
  tags?: CtTag[];
}

interface CpRow {
  title: string;
  meta: string;
  icon: string;
  /** Right-aligned keycap, when the row has a shortcut. */
  keys?: string;
  run: () => void;
  /** Set on a record row — what → and ⌘↵ act on. */
  record?: CpRecord;
  /** Tag chips shown after the title. */
  chips?: CtTag[];
}

interface CpGroup { label: string; rows: CpRow[] }

// ── Building the rows ────────────────────────────────────────────────────────

function cpCommandRow(cmd: Command): CpRow {
  return {
    title: cmd.title,
    meta: cmd.group,
    icon: cmd.icon,
    keys: keyLabel(cmd.keys),
    run: () => { paletteClose(); runCommand(cmd.id); },
  };
}

function cpRecordRow(r: CpRecord): CpRow {
  const where = r.projectName ? `${r.type} · ${r.projectName}` : r.type;
  return {
    title: r.name,
    meta: r.meta ? `${where} · ${r.meta}` : where,
    icon: CP_KIND_ICON[r.kind] || 'folder',
    record: r,
    chips: r.tags,
    run: () => { paletteClose(); void paletteOpenRecord(r); },
  };
}

const CP_KIND_ICON: Record<string, string> = {
  dataset: 'database',
  visual: 'columns',
  analysis: 'grid',
  capture: 'camera',
  connection: 'plug',
  metric: 'gauge',
  report: 'file-text',
  story: 'file-text',
  alert: 'bell',
};

/** A search hit or a recent item, both flattened to the one shape rows use. */
function cpToRecord(h: any): CpRecord {
  const kind = String(h.kind || h.type || '');
  const meta = h.snippet || h.sub
    || (h.meta && h.meta.rowCount != null ? Number(h.meta.rowCount).toLocaleString() + ' rows' : '');
  return {
    kind,
    id: String(h.id || ''),
    name: String(h.name || 'Untitled'),
    projectId: String(h.projectId || currentProjectId || ''),
    projectName: String(h.projectName || ''),
    meta: String(meta || ''),
    type: String(h.type && h.kind ? h.type : CP_KIND_LABEL[kind] || 'Record'),
    tags: Array.isArray(h.tags) ? h.tags : undefined,
  };
}

const CP_KIND_LABEL: Record<string, string> = {
  dataset: 'Dataset',
  visual: 'Visual',
  analysis: 'Dashboard',
  capture: 'Capture',
  connection: 'Connection',
  metric: 'Metric',
  report: 'Report',
  alert: 'Alert',
};

/** `#sal` — the project's tags as rows; picking one shows everything carrying it in the Catalog. */
function cpTagGroup(q: string): CpGroup | null {
  if (q.charAt(0) !== '#' || !ctTagsCache || ctTagsCache.projectId !== currentProjectId) return null;
  const want = ctNormTag(q);
  const rows = ctTagsCache.tags.filter((t) => !want || t.name.indexOf(want) === 0).slice(0, CP_MAX_SUGGEST).map((t) => ({
    title: 'Everything tagged #' + t.name,
    meta: `${t.count || 0} tagged · Catalog`,
    icon: 'filter',
    chips: [t],
    run: () => { paletteClose(); ctShowTag(t.name); },
  }));
  return rows.length ? { label: 'Tags', rows } : null;
}

/** The commands that belong to whatever is open, under the record's own name. */
function cpContextGroup(): CpGroup | null {
  const ref = typeof dkContextRef === 'function' ? dkContextRef() : null;
  if (!ref || !ref.kind) return null;
  // A contextual command is one that declared a `when()` — it is in the list
  // precisely because the current surface qualifies for it.
  const rows = listCommands()
    .filter((c) => typeof c.when === 'function')
    .map(cpCommandRow);
  if (!rows.length) return null;
  return { label: ref.name || ref.label, rows };
}

/**
 * "Chart `revenue` by `region`" — built from the open dataset's own columns.
 * App-chosen: the first numeric column against the first few text ones. Picking
 * one opens the builder already filled in; nothing is saved and no model is asked.
 */
function cpChartSuggestions(): CpGroup | null {
  if (!cmdDatasetOpen() || !Array.isArray(expColumns)) return null;
  const measure = expColumns.find((c: any) => c && c.type === 'number');
  if (!measure) return null;
  const cats = expColumns.filter((c: any) => c && c.type !== 'number').slice(0, CP_MAX_SUGGEST);
  if (!cats.length) return null;
  const datasetId = expId;
  const rows = cats.map((cat: any) => ({
    title: `Chart ${measure.name} by ${cat.name}`,
    meta: 'Visual · from ' + expName,
    icon: 'columns',
    run: () => {
      paletteClose();
      void cpOpenChart(datasetId, cat.name, measure.name);
    },
  }));
  return { label: 'Suggested', rows };
}

/** Open the builder on a preconfigured encoding — the same call a saved visual
 *  is restored with, so a suggestion cannot support a field a saved one cannot. */
async function cpOpenChart(datasetId: string, category: string, measure: string): Promise<void> {
  selectSection('visuals');
  await openVisualBuilder(datasetId);
  await onDatasetChange(datasetId, { category, values: [{ column: measure, aggregation: 'sum' }] });
}

/** `@` — the open dataset's columns. Picking one profiles it. */
function cpColumnGroups(q: string): CpGroup[] {
  if (!cmdDatasetOpen() || !Array.isArray(expColumns)) {
    return [{ label: 'Columns', rows: [] }];
  }
  const needle = q.trim().toLowerCase();
  const rows: CpRow[] = [];
  expColumns.forEach((c: any, i: number) => {
    const name = String((c && c.name) || '');
    if (needle && cmdScoreToken(needle, name.toLowerCase()) < 0) return;
    rows.push({
      title: name,
      meta: String((c && c.type) || 'text'),
      icon: 'table',
      run: () => { paletteClose(); void dsOpenProfile(i); },
    });
  });
  return [{ label: 'Columns in ' + expName, rows }];
}

/** The secondary actions on a record (→). */
function cpActionGroups(r: CpRecord): CpGroup[] {
  const rows: CpRow[] = [
    { title: 'Open', meta: r.name, icon: 'play', run: () => { paletteClose(); void paletteOpenRecord(r); } },
    { title: 'Ask about it', meta: 'In the Assistant', icon: 'sparkles', run: () => { paletteClose(); void paletteOpenInDock(r); } },
  ];
  // Star is Home's pin list, and Home paints datasets, dashboards and captures.
  // Offering it on a visual would write a key nothing ever shows.
  if (r.kind === 'dataset' || r.kind === 'analysis' || r.kind === 'capture') {
    rows.push({ title: 'Star', meta: 'Pin it on Home', icon: 'star', run: () => { paletteClose(); toggleStar({ type: r.kind, id: r.id }); } });
  }
  if (r.kind === 'visual') {
    rows.push({ title: 'Add to dashboard', meta: cmdDashboardOpen() ? 'The open dashboard' : 'Open a dashboard first', icon: 'grid', run: () => { paletteClose(); cpAddVisualToDashboard(r); } });
  }
  if (r.kind === 'analysis') {
    rows.push({ title: 'Export', meta: 'PDF, PNG or HTML', icon: 'download', run: () => { paletteClose(); void cpExportDashboard(r); } });
  }
  const histType = CP_HISTORY_TYPE[r.kind];
  if (histType) {
    rows.push({ title: 'Version history', meta: 'Every save, restorable', icon: 'history', run: () => { paletteClose(); void cpOpenHistory(r, histType); } });
  }
  const linType = CP_LINEAGE_TYPE[r.kind];
  if (linType) {
    rows.push({ title: 'Lineage', meta: 'What it is built from, and what uses it', icon: 'lineage', run: () => { paletteClose(); void cpOpenLineage(r, linType); } });
  }
  return [{ label: r.name, rows }];
}

/** Search kinds → version-history types. A dashboard is `analysis` to search. */
const CP_HISTORY_TYPE: Record<string, string> = {
  dataset: 'dataset', visual: 'visual', analysis: 'dashboard', metric: 'metric', report: 'report',
};

const CP_LINEAGE_TYPE: Record<string, string> = { ...CP_HISTORY_TYPE, alert: 'alert' };

/** Lineage is a panel over whatever page is showing: only the PROJECT has to
 *  be the record's, so the graph is read from the right place. */
async function cpOpenLineage(r: CpRecord, type: string): Promise<void> {
  if (r.projectId && r.projectId !== currentProjectId) await adoptProject(r.projectId);
  await lnOpen(type, r.id, r.name);
}

/** Open the record first, so a preview has its page to show on. */
async function cpOpenHistory(r: CpRecord, type: string): Promise<void> {
  await paletteOpenRecord(r);
  await vhOpen(type, r.id, r.name);
}

function cpAddVisualToDashboard(r: CpRecord): void {
  if (!cmdDashboardOpen()) { showToast('Open a dashboard first'); return; }
  pushCard({ id: dashUuid(), type: 'visual', visualId: r.id, layout: { ...dashFindSlot(dashCards(), 6, 6), w: 6, h: 6 } });
  showToast('Added to ' + (dashCurrent.name || 'the dashboard'));
}

async function cpExportDashboard(r: CpRecord): Promise<void> {
  await paletteOpenRecord(r);
  await handleDashExport();
}

/** Go to a record, through the section's OWN opener — never a second one. */
async function paletteOpenRecord(r: CpRecord): Promise<void> {
  if (r.kind === 'visual') {
    if (r.projectId && r.projectId !== currentProjectId) await openWorkspace(r.projectId);
    selectSection('visuals');
    await openSavedVisual(r.id);
    return;
  }
  if (r.kind === 'metric' || r.kind === 'story') { await ctOpenRecord(r.kind, r.id, r.projectId, r.name); return; }
  if (r.kind === 'connection') {
    if (r.projectId && r.projectId !== currentProjectId) await openWorkspace(r.projectId);
    selectSection('connect');
    return;
  }
  if (r.kind === 'metric' || r.kind === 'report' || r.kind === 'alert') {
    if (r.projectId && r.projectId !== currentProjectId) await openWorkspace(r.projectId);
    if (r.kind === 'report') { selectSection('analyses'); await rbOpenReportById(r.id); return; }
    if (r.kind === 'alert') { await aiOpenRulesPage(); return; }
    selectSection('datasets');
    clSelectTab('metrics');
    const res = await window.hub.getMetric(r.projectId || currentProjectId, r.id).catch(() => null);
    if (res && res.ok) await mpOpenEditor(res.metric);
    return;
  }
  // dataset · analysis · capture — Home's opener already does all three,
  // including adopting the record's project.
  await openRecentItem({ type: r.kind, id: r.id, projectId: r.projectId, name: r.name });
}

/** ⌘↵ — open the record, then the Assistant, which then names it as context. */
async function paletteOpenInDock(r: CpRecord): Promise<void> {
  await paletteOpenRecord(r);
  cmdOpenDock();
}

