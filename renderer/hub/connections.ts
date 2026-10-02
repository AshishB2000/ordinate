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
  /**
   * True when main can describe this source's tables, i.e. when the workbench's
   * schema browser has a catalog to read. REPORTED by the registry rather than
   * inferred from `family` here: gating the run UI on family is what cost seven
   * HTTP connectors their table picker once already.
   *
   * Optional, and absence means YES — an older main that does not send the flag
   * gets the tree, discovers the source has no catalog on the first expand, and
   * says so, which is a better failure than a feature silently missing.
   */
  browsable?: boolean;
  /** A SaaS source's fixed hosts, shown on its form. */
  hosts?: string[];
}

// Fixed display order; anything with an unrecognised category is appended under
// its own heading rather than dropped.
const CONN_CATEGORY_ORDER = [t('connections.databases'), t('connections.cloud_warehouses'), t('connections.query_engines'), t('connections.files_local'), t('connections.apps_saas')];

// What main has always supported, in main's own field keys. Used only when the
// catalog channel is unavailable.
const CONN_FALLBACK_CATALOG: ConnDef[] = [
  {
    id: 'postgres',
    label: 'PostgreSQL',
    family: 'postgres',
    category: t('connections.databases'),
    blurb: t('connections.read_only_access_to_a_postgres'),
    fields: [
      { key: 'host', label: t('connections.host'), type: 'text', default: 'localhost', placeholder: 'localhost' },
      { key: 'port', label: t('common.port'), type: 'number', default: 5432, placeholder: '5432' },
      { key: 'database', label: t('common.database'), type: 'text', required: true, placeholder: 'mydb' },
      { key: 'user', label: t('connections.user'), type: 'text', placeholder: 'postgres' },
      { key: 'password', label: t('connections.password'), type: 'password', secret: true, placeholder: '••••••••' },
      { key: 'ssl', label: 'SSL', type: 'checkbox', default: false },
      {
        key: 'table',
        label: t('common.table'),
        type: 'text',
        placeholder: t('connections.schema_table_optional'),
        help: t('connections.optional_you_can_also_pick_a'),
      },
      { key: 'query', label: t('common.query'), type: 'text', placeholder: t('connections.select_optional_overrides_table') },
    ],
  },
  {
    id: 'url',
    label: t('connections.url_api_json'),
    family: 'http',
    category: t('connections.files_local'),
    blurb: t('connections.fetch_json_from_an_https_endpoint'),
    fields: [
      { key: 'url', label: 'URL', type: 'text', required: true, placeholder: 'https://api.example.com/data.json' },
      {
        key: 'token',
        label: t('connections.auth_token'),
        type: 'password',
        secret: true,
        placeholder: t('connections.optional_bearer_token'),
        help: t('connections.sent_as_a_bearer_header_stored'),
      },
    ],
  },
];

// ── Module-local state ───────────────────────────────────────────────────────
//
// THE WORKBENCH'S STATE LIVES HERE, not in connWorkbench.ts, for the same
// reason the connector contract does: these are classic global-scope scripts
// with a fixed load order, and a `let` declared in the file that happens to
// read it first is a load-order dependency waiting to break. connections.js
// loads first and owns the state; connWorkbench.js and connEditor.js act on it.

/** The connection the workbench is open on (a PublicConnection), or null. */
let cwConn: any = null;
/** Its catalog entry — `browsable` decides whether the schema tree exists. */
let cwDef: ConnDef | null = null;
/** Tables as listTables reported them. The tree groups these by schema. */
let cwTables: { schema?: string; name: string }[] = [];
/** Column names per qualified table name, filled lazily as the tree expands.
 *  Doubles as the autocomplete vocabulary — one fetch serves both. */
const cwColumns = new Map<string, string[]>();
/** The table whose sample is showing, '' when the results came from a query. */
let cwTable = '';
/** The last result, held for "Save as dataset". */
let cwPreview: any = null;
/** WHAT produced cwPreview, so the dataset's origin re-runs exactly that.
 *  Exactly one of the two is set. */
let cwPreviewTable = '';
let cwPreviewSql = '';
/** The saved query the editor is currently editing ('' = an ad-hoc statement).
 *  Carried onto the dataset origin as a LABEL — never as what to re-run. */
let cwQueryId = '';
/** Datasets already imported from this connection (summaries), for the rail. */
let cwDatasets: any[] = [];

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

/** Rows the grid paints. Also the bound main is asked for on a preview Run —
 *  the import row limit is a separate, explicit choice in the editor's bar. */
const CONN_PREVIEW_ROWS = 500;

type ConnLogo = { path?: string; color?: string; title?: string; src?: string };
const CONN_LOGOS: Record<string, ConnLogo> =
  (window.hub && window.hub.connectorLogos) || {};
const CONN_ACTION_LOGOS: Record<string, ConnLogo> = {
  // The sidebar "CSV / Excel" shortcut IMPORTS a file — a down-arrow into a tray,
  // not a data-source logo. It is an action mark like home-paste, so it lives
  // here rather than in the per-source CONN_LOGOS the catalog draws from.
  'home-import': {
    path: 'M11 3h2v7h3l-4 4-4-4h3V3Z M4 13v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6h-2v5H6v-5H4Z',
    color: 'currentColor',
    title: t('common.import_file'),
  },
  'home-paste': {
    path: 'M9 2h6a2 2 0 0 1 2 2h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2-2Zm0 4h6V4H9v2Zm-2 3v2h10V9H7Zm0 4v2h10v-2H7Zm0 4v2h7v-2H7Z',
    color: 'currentColor',
    title: t('common.paste_data'),
  },
  'home-capture': {
    src: 'assets/connectors/screenchart.png',
    title: t('common.screenshot'),
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
// The connector a shortcut asked to land on, handed to the NEXT refreshConnPanel().
//
// This is a handoff, not state. openConnPanel cannot select the connector itself:
// Connect is a section, so opening it goes through selectSection, which fires
// refreshConnPanel() once the section is active — and that reload would blow any
// earlier selection straight back to the picker. Parking the id here lets the one
// function that owns the panel's content apply it, so the two never fight.
//
// It is consumed on every refresh, including the ones where the lookup fails, so
// a stale id can never survive to the next visit and reopen a form nobody asked
// for.
let connPendingPreselect = '';

/**
 * Open the connect panel, optionally landing straight on one connector's form.
 *
 * `preselectId` is what makes the sidebar's PostgreSQL / MySQL shortcuts mean
 * anything: without it every one of them opened the same 35-source grid, so a
 * named entry saved the user no step at all — they still had to find their
 * database in the catalog.
 *
 * Connect is a SECTION, so showing it is selectSection's job and this must not
 * also toggle `hidden` — the two would fight, and whichever ran last would win.
 * openConnPanel therefore only routes; refreshConnPanel below is the part that
 * loads content, and the router calls it once the section is active.
 */
function openConnPanel(preselectId?: string): void {
  connPendingPreselect = preselectId || '';
  if (typeof selectSection === 'function') { selectSection('connect'); return; }
  // No router in scope (a DOM harness loading this file alone): show it directly
  // so the panel is still usable rather than silently doing nothing.
  connShow('conn-panel', true);
  void refreshConnPanel();
}

// Reset to step 1 and reload the catalogue + saved connections. Called by
// selectSection whenever the Connect section becomes active, so the picker is
// never left showing a half-filled form from a previous visit — unless a
// shortcut asked for a named connector, which is the one thing allowed to
// replace step 1 with step 2.
async function refreshConnPanel(): Promise<void> {
  const preselect = connPendingPreselect;
  connPendingPreselect = '';
  connSetError('');
  // Walking into Connect always lands on the browse flow. The workbench is
  // reached by opening a connection, and leaving it must not be something the
  // router can do behind connWorkbench.ts's back.
  closeConnWorkbench();
  await loadConnCatalog();
  // An unknown id falls back to the picker rather than failing, because the
  // catalog is resolved from the live registry and a shortcut must never be able
  // to open a dead panel.
  const pick = preselect ? connDefById(preselect) : null;
  if (pick) connSelectConnector(pick);
  else connShowPicker();
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

  initConnWorkbench();
  initConnEditor();
}
