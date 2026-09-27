'use strict';

// The TAB KINDS — which records can be tabs, and how. ONE table: a new record
// type becomes a tab by adding one entry here. Nothing in tabNav.ts,
// tabStrip.ts or tabSplit.ts names a kind.
//
// Every record page in this app is a SINGLETON (one dataset explorer, one
// visual builder, one dashboard editor), so an entry describes that page:
//
//   section  the .ws-panel the page lives in. Two records share the screen
//            (split view) only when their sections differ.
//   open     show record `id` through the section's OWN opener — never a
//            second one. Lands on the section itself.
//   close    put the page back on its list, the way its Back button does.
//            Returns false when the user chose to keep it (unsaved changes).
//            Never navigates: it is also called on a page that is not showing.
//   current  the record the page has open right now, or null.
//   resolve  the record's name, or null when it no longer exists. A failed
//            lookup is NOT "gone" — it answers '' so a tab survives a hiccup.
//   isDirty  unsaved changes on the open record (the tab's dirty dot).
//
// Metrics (a modal, not a page) and connections are deliberately not kinds.
//
// Classic global-scope renderer <script>: NO import/export.

interface TabKind {
  icon: string;
  label: string;
  section: string;
  open: (id: string) => Promise<void>;
  close: () => boolean | Promise<boolean>;
  current: () => { id: string; name: string } | null;
  resolve: (projectId: string, id: string) => Promise<string | null>;
  isDirty: () => boolean;
}

function tkShown(id: string): boolean {
  const el = document.getElementById(id);
  return !!el && !el.hidden;
}

/** A record's name off a `get` call: null only when main answered "no such record". */
async function tkName(get: Promise<any>, field = 'name'): Promise<string | null> {
  try {
    const rec = await get;
    return rec ? String(rec[field] || '') : null;
  } catch (_) {
    return '';
  }
}

const TAB_KINDS: Record<string, TabKind> = {
  dataset: {
    icon: 'database',
    label: 'Dataset',
    section: 'datasets',
    open: async (id) => { selectSection('datasets'); await openSavedDataset(id); },
    close: () => {
      if (tkShown('ds-explorer')) document.getElementById('ds-explorer-close')?.click();
      return true;
    },
    current: () => (expId && tkShown('ds-explorer') ? { id: expId, name: expName } : null),
    resolve: (pid, id) => tkName(window.hub.getDatasetMeta(pid, id)),
    isDirty: () => false,
  },
  visual: {
    icon: 'chart-bar',
    label: 'Visual',
    section: 'visuals',
    // openSavedVisual over an OPEN builder stacks a second set of chart
    // controls on the first, so the builder is closed first — and a visual
    // that is already open only needs its section back.
    open: async (id) => {
      selectSection('visuals');
      if (vizEditingId === id) return;
      if (vizEditingId) closeVisualBuilder();
      await openSavedVisual(id);
    },
    close: () => { closeVisualBuilder(); return true; },
    // vizEditingId alone, as the dock reads it: openSavedVisual announces the
    // record (dkSync) BEFORE it swaps the gallery for the builder, and
    // closeVisualBuilder clears it on the way out.
    current: () => (vizEditingId
      ? { id: vizEditingId, name: (document.getElementById('viz-builder-name')?.textContent || '').trim() }
      : null),
    resolve: (pid, id) => tkName(window.hub.getVisual(pid, id)),
    isDirty: () => false,
  },
  // Stored as an Analysis record; the product calls it a dashboard.
  analysis: {
    icon: 'layout-dashboard',
    label: 'Dashboard',
    section: 'analyses',
    open: async (id) => { selectSection('analyses'); await openAnalysis(id); },
    close: async () => { if (dashCurrent) await handleBackToList(); return true; },
    current: () => (dashMode === 'analysis' && dashCurrent && dashCurrent.id
      ? { id: String(dashCurrent.id), name: String(dashCurrent.name || '') }
      : null),
    resolve: (pid, id) => tkName(window.hub.getAnalysis(pid, id)),
    isDirty: () => !!dashCurrent && dashDirty,
  },
  report: {
    icon: 'file-text',
    label: 'Report',
    section: 'analyses',
    open: (id) => rbOpenReportById(id),
    // The same question the builder's own Back asks.
    close: () => {
      if (rbDirty && !window.confirm('Discard unsaved changes to this report?')) return false;
      rbClose();
      return true;
    },
    current: () => (rbReport && tkShown('rp-builder')
      ? { id: String(rbReport.id), name: String(rbReport.name || '') }
      : null),
    resolve: (pid, id) => tkName(window.hub.reportsGet(pid, id)),
    isDirty: () => !!rbReport && rbDirty,
  },
  // A story page shares the Dashboards section with the dashboard editor and
  // the report builder, so like a report it cannot sit beside one in a split.
  story: {
    icon: 'file-text',
    label: 'Story',
    section: 'analyses',
    open: (id) => stOpen(id),
    close: async () => { await stClose(); return true; },
    current: () => (stIsOpen() ? { id: String(stStory.id), name: String(stStory.name || '') } : null),
    resolve: (pid, id) => tkName(window.hub.getStory(pid, id)),
    // A save waiting on the debounce is an unsaved change.
    isDirty: () => stIsOpen() && !!stSaveTimer,
  },
  // A scorecard page shares the Dashboards section too, exactly like a story.
  scorecard: {
    icon: 'target',
    label: 'Scorecard',
    section: 'analyses',
    open: (id) => scOpen(id),
    close: async () => { await scClose(); return true; },
    current: () => (scCurrent && tkShown('sc-page') ? { id: scCurrent.id, name: scCurrent.name } : null),
    resolve: (pid, id) => tkName(window.hubPower.scorecardGet(pid, id)),
    isDirty: () => false,
  },
  // A capture's id is its numeric entry id; tabs carry it as a string.
  capture: {
    icon: 'camera',
    label: 'Capture',
    section: 'capture',
    open: async (id) => {
      const live = entries.find((e) => String(e.id) === id);
      if (live) { openCapture(live.id); return; }
      const list = currentProjectId ? await window.hub.listCaptures(currentProjectId) : [];
      const summary = (Array.isArray(list) ? list : []).find((c) => String(c.id) === id);
      if (summary) openCaptureFromSummary(summary);
    },
    close: () => { showCaptureList(); return true; },
    // Leaving the page leaves the capture: there is no hidden capture page to
    // come back to, and close() here navigates, so it must only ever run on
    // the page that is showing.
    current: () => {
      if (currentSection !== 'capture' || currentEntryId == null) return null;
      const e = getEntry(currentEntryId);
      return { id: String(currentEntryId), name: String((e && e.title) || 'Capture') };
    },
    resolve: async (pid, id) => {
      try {
        const list = await window.hub.listCaptures(pid);
        const c = (Array.isArray(list) ? list : []).find((x) => String(x.id) === id);
        return c ? String(c.title || 'Capture') : null;
      } catch (_) {
        return '';
      }
    },
    isDirty: () => false,
  },
};
