// Connected data sources UI. Classic global-scope renderer <script> — NO
// import/export; symbols are shared with the other hub scripts. Consumes
// window.hub.* (the connection:* bridge) and the shared currentProjectId
// (workspace.ts), formatSidebarTime (hub.ts), and refreshDatasetList
// (datasets.ts).
//
// THE FORM IS DATA-DRIVEN. There is no per-connector code in this file. The
// picker and every input are built from the `connectors:catalog` contract, so
// adding a data source is adding a connector definition in main — not editing a
// <select>, a field block, and a value-collector here, which is what the
// hardcoded Postgres/URL form forced.
//
// GRACEFUL DEGRADATION: if window.hub.connectorCatalog is missing or throws,
// CONN_FALLBACK_CATALOG describes the two sources main has always supported, in
// exactly the field keys src/ipc/connections.ts already reads. An old main and a
// new renderer therefore behave identically to before, rather than rendering an
// empty panel.
//
// SECURITY: a value typed into a `secret: true` field travels ONE-WAY to main
// inside the `secret` argument of testAndSaveConnection and is NEVER read back.
// connRenderFields refuses to write a secret key into the DOM even when handed
// one — the renderer is not supposed to receive stored secrets at all, so a
// value arriving there is a main-process bug, not something to display. All
// names/values are rendered as textContent only. No inline style= (CSP);
// toggles use .hidden.

// ── The connector contract, as the renderer sees it ──────────────────────────
// Mirrors src/connectors/types.ts (ConnectorField / ConnectorDef minus the
// main-only methods). Duplicated rather than imported because renderer files are
// classic scripts with no module system.
interface ConnFieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'password' | 'select' | 'checkbox' | 'textarea';
  required?: boolean;
  placeholder?: string;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  secret?: boolean;
  help?: string;
}

interface ConnDef {
  id: string;
  label: string;
  family: string;
  category: string;
  blurb?: string;
  fields: ConnFieldDef[];
}

// Fixed display order; anything with an unrecognised category is appended under
// its own heading rather than dropped.
const CONN_CATEGORY_ORDER = ['Databases', 'Cloud warehouses', 'Query engines', 'Files & local'];

// What main has always supported, in main's own field keys. Used only when the
// catalog channel is unavailable.
const CONN_FALLBACK_CATALOG: ConnDef[] = [
  {
    id: 'postgres',
    label: 'PostgreSQL',
    family: 'postgres',
    category: 'Databases',
    blurb: 'Read-only access to a Postgres database.',
    fields: [
      { key: 'host', label: 'Host', type: 'text', default: 'localhost', placeholder: 'localhost' },
      { key: 'port', label: 'Port', type: 'number', default: 5432, placeholder: '5432' },
      { key: 'database', label: 'Database', type: 'text', required: true, placeholder: 'mydb' },
      { key: 'user', label: 'User', type: 'text', placeholder: 'postgres' },
      { key: 'password', label: 'Password', type: 'password', secret: true, placeholder: '••••••••' },
      { key: 'ssl', label: 'SSL', type: 'checkbox', default: false },
      {
        key: 'table',
        label: 'Table',
        type: 'text',
        placeholder: 'schema.table (optional)',
        help: 'Optional. You can also pick a table after connecting.',
      },
      { key: 'query', label: 'Query', type: 'text', placeholder: 'select … (optional; overrides table)' },
    ],
  },
  {
    id: 'url',
    label: 'URL / API (JSON)',
    family: 'http',
    category: 'Files & local',
    blurb: 'Fetch JSON from an https endpoint.',
    fields: [
      { key: 'url', label: 'URL', type: 'text', required: true, placeholder: 'https://api.example.com/data.json' },
      {
        key: 'token',
        label: 'Auth token',
        type: 'password',
        secret: true,
        placeholder: 'Optional Bearer token',
        help: 'Sent as a Bearer header. Stored outside the shareable project folder.',
      },
    ],
  },
];

// ── Module-local state ───────────────────────────────────────────────────────
let connRunConnId = ''; // connId whose result is shown in the run area
let connRunKind = ''; // connector id of the connection being run
let connRunFamily = ''; // its family ('postgres' | 'http' | …) — drives the run UI
let connRunPreview: any = null; // last run ParseResult, held for "save as dataset"

let connCatalog: ConnDef[] = []; // resolved once per panel open
let connCatalogLoaded = false;
// True when the catalogue channel was unavailable or errored and the two-source
// fallback is in use. Drives the on-screen notice; see loadConnCatalog().
let connCatalogDegraded = false;
let connSelected: ConnDef | null = null; // the connector whose form is showing
let connSearch = ''; // current picker filter
// Non-secret answers kept per connector id so "Change source" and back is not
// destructive. NEVER holds a secret — see connShowPicker.
const connDraftValues: Record<string, Record<string, unknown>> = {};

const CONN_PREVIEW_ROWS = 500; // display-only slice (full capped rows stay in connRunPreview)

type ConnLogo = { path?: string; color?: string; title?: string; src?: string };
const CONN_LOGOS: Record<string, ConnLogo> =
  (window.hub && window.hub.connectorLogos) || {};
const CONN_ACTION_LOGOS: Record<string, ConnLogo> = {
  'home-paste': {
    path: 'M9 2h6a2 2 0 0 1 2 2h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2-2Zm0 4h6V4H9v2Zm-2 3v2h10V9H7Zm0 4v2h10v-2H7Zm0 4v2h7v-2H7Z',
    color: 'currentColor',
    title: 'Paste data',
  },
  'home-capture': {
    src: 'assets/connectors/screenchart.png',
    title: 'Screenshot',
  },
};

// ── Small DOM helpers ────────────────────────────────────────────────────────
function connEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function connShow(id: string, show: boolean): void {
  const el = connEl(id);
  if (el) el.hidden = !show;
}

function connSetError(msg: string): void {
  const box = connEl('conn-error');
  if (!box) return;
  if (msg) {
    box.textContent = msg;
    box.hidden = false;
  } else {
    box.textContent = '';
    box.hidden = true;
  }
}

function connVal(id: string): string {
  const el = connEl(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  return el && typeof el.value === 'string' ? el.value.trim() : '';
}

// ── Panel open/close ─────────────────────────────────────────────────────────
// Connect is a SECTION now, so showing it is selectSection's job and this must
// not also toggle `hidden` — the two would fight, and whichever ran last would
// win. openConnPanel therefore only routes; refreshConnPanel below is the part
// that loads content, and the router calls it once the section is active.
function openConnPanel(): void {
  if (typeof selectSection === 'function') { selectSection('connect'); return; }
  // No router in scope (a DOM harness loading this file alone): show it directly
  // so the panel is still usable rather than silently doing nothing.
  connShow('conn-panel', true);
  void refreshConnPanel();
}

// Reset to step 1 and reload the catalogue + saved connections. Called by
// selectSection whenever the Connect section becomes active, so the picker is
// never left showing a half-filled form from a previous visit.
async function refreshConnPanel(): Promise<void> {
  connSetError('');
  await loadConnCatalog();
  connShowPicker();
  await refreshConnectionList();
}

// Close returns to whatever was showing before Connect — Home if there was
// nothing, so this can never strand the user on a hidden section.
function closeConnPanel(): void {
  if (typeof leaveSection === 'function') { leaveSection('connect'); return; }
  connShow('conn-panel', false);
}

// ── Boot wiring (once) ───────────────────────────────────────────────────────
function initConnections(): void {
  const openBtn = connEl('conn-connect-btn');
  if (openBtn) openBtn.addEventListener('click', () => openConnPanel());

  const closeBtn = connEl('conn-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', () => closeConnPanel());

  const search = connEl('conn-search') as HTMLInputElement | null;
  if (search) {
    search.addEventListener('input', () => {
      connSearch = search.value;
      connRenderPicker();
    });
  }

  const groups = connEl('conn-groups');
  if (groups) groups.addEventListener('keydown', (e) => connPickerKeydown(e as KeyboardEvent));

  // Back to the picker. Non-secret answers survive the round trip; secrets do
  // not, because connRenderFields refuses to prefill them.
  const changeBtn = connEl('conn-change-btn');
  if (changeBtn) changeBtn.addEventListener('click', () => connShowPicker(true));

  const testBtn = connEl('conn-test-btn');
  if (testBtn) testBtn.addEventListener('click', () => handleConnTestAndSave());

  const runBtn = connEl('conn-run-btn');
  if (runBtn) runBtn.addEventListener('click', () => handleConnRun());

  const runClose = connEl('conn-run-close');
  if (runClose) runClose.addEventListener('click', () => closeRunArea());

  const saveBtn = connEl('conn-save-ds-btn');
  if (saveBtn) saveBtn.addEventListener('click', () => handleConnSaveAsDataset());
}
