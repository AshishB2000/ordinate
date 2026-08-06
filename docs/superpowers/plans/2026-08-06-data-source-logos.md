# Data-source Logos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give all 35 Connect data sources the approved compact left-logo treatment, using bundled official marks where available and deterministic two-letter badges otherwise.

**Architecture:** Extend the existing build-time Simple Icons asset with an explicit connector map, and load the supplied full-colour Redshift PNG through a new renderer-safe `connectorLogos` map. The connector catalog remains unchanged; the generic renderer looks up logos by connector id and falls back locally.

**Tech Stack:** Electron 42, TypeScript classic-script renderer, Node `fs`/`path`, Simple Icons 16.23.0 as an existing devDependency, Node's built-in test runner, Playwright Electron smoke test.

## Global Constraints

- Branch from `develop`; never commit directly to `develop` or `main`.
- Do not add a runtime dependency.
- Keep the app fully offline; never fetch brand artwork at runtime.
- Keep the connector catalog schema unchanged.
- Preserve the hub CSP; do not add inline `style=` attributes or a new CSP source.
- Do not add `eval`, `new Function`, `shell: true`, secrets, or executable user/model input.
- Use official bundled marks where suitable and a neutral two-letter badge otherwise; never label a fallback badge as an official trademark.
- Before every commit, show the exact title and body to the user and wait for approval. Never add a co-author trailer.

---

### Task 1: Build and expose offline connector-logo assets

**Files:**
- Create: `scripts/test-icons.ts`
- Create: `renderer/hub/assets/connectors/amazon-redshift.png`
- Modify: `src/icons.ts`
- Modify: `scripts/build-icons.js`
- Modify: `assets/provider-icons.json` (generated)
- Modify: `src/ipc/shell.ts`
- Modify: `preload/hubPreload.ts`
- Modify: `renderer/hub/globals.d.ts`

**Interfaces:**
- Produces: `CONNECTOR_SI: Record<string, string>` in `src/icons.ts`.
- Produces: `connectorLogos: Record<string, { path: string; color: string; title: string; export: string } | { src: string; title: string }>` in `src/icons.ts`.
- Produces: synchronous IPC channel `connector:logos` returning `connectorLogos`.
- Produces: `window.hub.connectorLogos` with the same renderer-safe shape.

- [ ] **Step 1: Write the failing asset-boundary test**

Create `scripts/test-icons.ts`. The production break this catches is removing a mapped connector path, failing to ship the supplied Redshift image, or leaking filesystem paths/functions through the preload payload.

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

process.env.SCREENCHART_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-icons-'));

const icons = require('../src/icons') as Record<string, any>;

let failures = 0;
function ok(label: string, cond: boolean, extra = ''): void {
  if (cond) console.log('ok   ' + label + (extra ? '  ' + extra : ''));
  else { console.error('FAIL ' + label + (extra ? '  ' + extra : '')); failures++; }
}

const mapped = icons.CONNECTOR_SI || {};
const logos = icons.connectorLogos || {};

ok('PostgreSQL has an explicit official mapping', mapped.postgres === 'siPostgresql');
ok('mapped PostgreSQL resolves to a bundled path',
  typeof logos.postgres?.path === 'string' && logos.postgres.path.length > 20);
ok('Amazon Redshift resolves to the supplied local PNG',
  typeof logos['amazon-redshift']?.src === 'string' &&
  logos['amazon-redshift'].src.startsWith('data:image/png;base64,'));
ok('connector logos are structured-clone safe', (() => {
  try { structuredClone(logos); return true; } catch (_) { return false; }
})());
ok('connector logos expose no filesystem paths or functions', (() => {
  const json = JSON.stringify(logos);
  return !json.includes('/Users/') && !json.includes('/var/folders/') &&
    !Object.values(logos).some((v: any) => Object.values(v).some((x) => typeof x === 'function'));
})());

fs.rmSync(process.env.SCREENCHART_USER_DATA, { recursive: true, force: true });
if (failures) process.exit(1);
console.log('\nAll connector icon checks passed.');
```

- [ ] **Step 2: Build and run the focused test to verify RED**

Run:

```bash
npm run build:ts
node scripts/test-icons.js
```

Expected: build succeeds, then the test reports failures for the missing `CONNECTOR_SI`, PostgreSQL logo, and Redshift image.

- [ ] **Step 3: Add explicit connector mappings and the full-colour asset loader**

In `src/icons.ts`, add this map next to `PROVIDER_SI`:

```ts
export const CONNECTOR_SI: Record<string, string> = {
  postgres: 'siPostgresql',
  cockroachdb: 'siCockroachlabs',
  timescaledb: 'siTimescale',
  mysql: 'siMysql',
  mariadb: 'siMariadb',
  tidb: 'siTidb',
  planetscale: 'siPlanetscale',
  alloydb: 'siGooglecloud',
  neon: 'siNeon',
  supabase: 'siSupabase',
  singlestore: 'siSinglestore',
  doris: 'siApachedoris',
  clickhouse: 'siClickhouse',
  'databricks-sql': 'siDatabricks',
  trino: 'siTrino',
  presto: 'siPresto',
  elasticsearch: 'siElasticsearch',
  opensearch: 'siOpensearch',
  druid: 'siApachedruid',
  'duckdb-file': 'siDuckdb',
  'parquet-folder': 'siApacheparquet',
  url: 'siJson',
};
```

Read the generated glyphs with the same validation and `safeColor()` call used by `providerLogos`. Then overlay local full-colour assets from `renderer/hub/assets/connectors`:

```ts
export type BrandGlyph = { path: string; color: string; title: string; export: string };
export type BrandImage = { src: string; title: string };

const CONNECTOR_DIR = path.join(__dirname, '..', 'renderer', 'hub', 'assets', 'connectors');

export const connectorLogos = (() => {
  const out: Record<string, BrandGlyph | BrandImage> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(ICON_ASSET, 'utf8'));
    const entries = (raw && raw.icons) || {};
    for (const id of Object.keys(CONNECTOR_SI)) {
      const ic = entries[id];
      if (ic?.path) out[id] = {
        path: ic.path, color: safeColor(ic.hex), title: ic.title, export: ic.export,
      };
    }
  } catch (_) { /* renderer falls back to badges */ }
  try {
    for (const file of fs.readdirSync(CONNECTOR_DIR)) {
      const match = /^(.+)\.(svg|png)$/i.exec(file);
      if (!match) continue;
      const ext = match[2].toLowerCase();
      const mime = ext === 'svg' ? 'image/svg+xml' : 'image/png';
      const src = `data:${mime};base64,` + fs.readFileSync(path.join(CONNECTOR_DIR, file)).toString('base64');
      out[match[1].toLowerCase()] = { src, title: match[1] };
    }
  } catch (_) { /* renderer falls back to badges */ }
  return out;
})();
```

Keep `providerLogos` behavior unchanged.

- [ ] **Step 4: Add the supplied Redshift PNG**

Create the target directory and copy the exact user-provided file:

```bash
mkdir -p renderer/hub/assets/connectors
cp /var/folders/cg/zcqkznv5199_yzy7n_1rc7t00000gn/T/codex-clipboard-2c861073-a80d-4400-a5a6-a39033ad6a82.png renderer/hub/assets/connectors/amazon-redshift.png
```

Confirm it is a PNG before continuing:

```bash
file renderer/hub/assets/connectors/amazon-redshift.png
```

Expected: `PNG image data`.

- [ ] **Step 5: Extend the existing generator and regenerate the committed asset**

In `scripts/build-icons.js`, load both maps and bake their union:

```js
let PROVIDER_SI, CONNECTOR_SI;
({ PROVIDER_SI, CONNECTOR_SI } = require('../src/icons'));
const ALL_SI = { ...PROVIDER_SI, ...CONNECTOR_SI };

for (const [id, name] of Object.entries(ALL_SI)) {
  const ic = si[name];
  if (!ic || !ic.path) {
    missing.push(`${id} → ${name}`);
    continue;
  }
  out[id] = { path: ic.path, hex: ic.hex, title: ic.title, export: name };
}
```

Run:

```bash
npm run build:ts
npm run build:icons
```

Expected: the generator reports 28 icons: 6 providers plus 22 connectors, and rewrites `assets/provider-icons.json`.

- [ ] **Step 6: Expose the connector-logo map through main and preload**

In `src/ipc/shell.ts`, import `connectorLogos` and register one synchronous static channel:

```ts
ipcMain.on('connector:logos', (e) => { e.returnValue = connectorLogos; });
```

In `preload/hubPreload.ts`, read the map beside the other logo payloads and expose it:

```ts
let CONNECTOR_LOGOS: any = {};
try { CONNECTOR_LOGOS = ipcRenderer.sendSync('connector:logos') || {}; } catch (_) { CONNECTOR_LOGOS = {}; }

// inside exposeInMainWorld('hub', { ... })
connectorLogos: CONNECTOR_LOGOS,
```

In `renderer/hub/globals.d.ts`, add:

```ts
connectorLogos: Record<string,
  { path: string; color: string; title: string } |
  { src: string; title: string }
>;
```

- [ ] **Step 7: Rebuild and verify GREEN**

Run:

```bash
npm run build:ts
node scripts/test-icons.js
npm run icons:verify
node scripts/test-connectors.js
```

Expected: all connector icon checks pass; provider verification remains unchanged; all connector registry checks pass.

- [ ] **Step 8: Request approval and commit Task 1**

Propose this exact message and wait for approval:

```text
Bundle connector brand assets

Extend the offline icon pipeline with connector marks and expose a
renderer-safe logo map, including the supplied Amazon Redshift artwork.
```

After approval:

```bash
git add scripts/test-icons.ts scripts/test-icons.js src/icons.ts src/icons.js scripts/build-icons.js assets/provider-icons.json src/ipc/shell.ts src/ipc/shell.js preload/hubPreload.ts preload/hubPreload.js renderer/hub/globals.d.ts renderer/hub/assets/connectors/amazon-redshift.png
git commit -m "Bundle connector brand assets" -m "Extend the offline icon pipeline with connector marks and expose a renderer-safe logo map, including the supplied Amazon Redshift artwork."
```

---

### Task 2: Render compact logo blocks in picker tiles and the selected-source header

**Files:**
- Modify: `renderer/hub/connections.ts`
- Modify: `renderer/hub/connections.js` (generated)
- Modify: `renderer/hub/index.html`
- Modify: `renderer/hub/hub.css`
- Modify: `scripts/smoke-app.ts`
- Modify: `scripts/smoke-app.js` (generated)

**Interfaces:**
- Consumes: `window.hub.connectorLogos` from Task 1.
- Produces: `connInitials(label: string): string`.
- Produces: `connMakeLogo(d: ConnDef): HTMLElement`, returning a decorative `.conn-logo` containing an image, SVG, or `.conn-logo-fallback` text badge.
- Produces: `connRenderChosenLogo(d: ConnDef): void`, replacing the children of `#conn-chosen-logo`.

- [ ] **Step 1: Add failing real-app assertions before renderer changes**

In `scripts/smoke-app.ts`, after the first window loads and before unrelated workflow navigation, open the real generic picker and inspect its DOM:

```ts
await win.evaluate(async () => { await openConnPanel(); });
await win.waitForTimeout(300);

const logoPicker = await win.evaluate(() => {
  const tiles = [...document.querySelectorAll<HTMLButtonElement>('.conn-tile')];
  const byId = (id: string) => document.querySelector<HTMLButtonElement>(`.conn-tile[data-connector-id="${id}"]`);
  const redshift = byId('amazon-redshift');
  const postgres = byId('postgres');
  const sqlserver = byId('sqlserver');
  return {
    count: tiles.length,
    everyTileHasLogo: tiles.every((tile) => !!tile.querySelector('.conn-logo')),
    redshiftIsImage: !!redshift?.querySelector('.conn-logo img[src^="data:image/png;base64,"]'),
    postgresIsSvg: !!postgres?.querySelector('.conn-logo svg path'),
    sqlserverFallback: sqlserver?.querySelector('.conn-logo-fallback')?.textContent || '',
    logosDecorative: tiles.every((tile) => tile.querySelector('.conn-logo')?.getAttribute('aria-hidden') === 'true'),
  };
});
ok('all 35 connector tiles have a logo block', logoPicker.count === 35 && logoPicker.everyTileHasLogo, JSON.stringify(logoPicker));
ok('Redshift uses the supplied image and PostgreSQL uses a bundled glyph',
  logoPicker.redshiftIsImage && logoPicker.postgresIsSvg, JSON.stringify(logoPicker));
ok('an unmapped source gets a deterministic fallback badge', logoPicker.sqlserverFallback === 'MS', logoPicker.sqlserverFallback);
ok('connector logos are decorative', logoPicker.logosDecorative);

await win.click('.conn-tile[data-connector-id="amazon-redshift"]');
const chosenHasLogo = await win.evaluate(() =>
  !!document.querySelector('#conn-chosen-logo img[src^="data:image/png;base64,"]'));
ok('the selected-source header repeats its logo', chosenHasLogo);
await win.click('#conn-close-btn');
```

The production breaks caught are: missing logo blocks, using the wrong rendering mode, losing the fallback, exposing decorative art to assistive technology, or failing to repeat the selected logo.

- [ ] **Step 2: Run smoke to verify RED**

Run:

```bash
SMOKE_ARTIFACT_DIR=/tmp/ordinate-logo-red npm run smoke
```

Expected: the new logo assertions fail because `.conn-logo` and `#conn-chosen-logo` do not exist. Existing assertions should continue running.

- [ ] **Step 3: Add the chosen-source logo host**

In `renderer/hub/index.html`, change `.conn-chosen-head` to group a logo host with the existing text:

```html
<div class="conn-chosen-ident">
  <span class="conn-logo" id="conn-chosen-logo" aria-hidden="true"></span>
  <div class="conn-chosen-text">
    <span class="conn-chosen-name" id="conn-chosen-name"></span>
    <span class="conn-chosen-blurb" id="conn-chosen-blurb"></span>
  </div>
</div>
```

Keep the existing Change source button as the second child of `.conn-chosen-head`.

- [ ] **Step 4: Add the minimal renderer helpers and use them in both locations**

Near the connector renderer state in `renderer/hub/connections.ts`, read the static map:

```ts
type ConnLogo = { path?: string; color?: string; title?: string; src?: string };
const CONN_LOGOS: Record<string, ConnLogo> =
  (window.hub && window.hub.connectorLogos) || {};
```

Add these helpers before `connMakeTile`:

```ts
function connInitials(label: string): string {
  const words = label.replace(/\([^)]*\)/g, '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function connMakeLogo(d: ConnDef): HTMLElement {
  const host = document.createElement('span');
  host.className = 'conn-logo';
  host.setAttribute('aria-hidden', 'true');
  const logo = CONN_LOGOS[d.id];
  if (logo?.src) {
    const img = document.createElement('img');
    img.src = logo.src;
    img.alt = '';
    host.appendChild(img);
  } else if (logo?.path) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', logo.path);
    path.setAttribute('fill', logo.color || 'currentColor');
    svg.appendChild(path);
    host.appendChild(svg);
  } else {
    host.classList.add('conn-logo-fallback');
    host.textContent = connInitials(d.label);
  }
  return host;
}

function connRenderChosenLogo(d: ConnDef): void {
  const host = connEl('conn-chosen-logo');
  if (!host) return;
  host.replaceChildren(...connMakeLogo(d).childNodes);
  host.className = connMakeLogo(d).className;
  host.setAttribute('aria-hidden', 'true');
}
```

Avoid constructing the logo twice by assigning `const logo = connMakeLogo(d)` inside `connRenderChosenLogo`, then copying its class and moving its children.

Update `connMakeTile` so its children are the logo plus one text wrapper:

```ts
btn.appendChild(connMakeLogo(d));
const copy = document.createElement('span');
copy.className = 'conn-tile-copy';

const label = document.createElement('span');
label.className = 'conn-tile-label';
label.textContent = d.label;
copy.appendChild(label);

if (d.blurb) {
  const blurb = document.createElement('span');
  blurb.className = 'conn-tile-blurb';
  blurb.textContent = d.blurb;
  copy.appendChild(blurb);
}
btn.appendChild(copy);
```

Call `connRenderChosenLogo(d)` at the start of `connSelectConnector`.

- [ ] **Step 5: Apply the approved Option A CSS**

In `renderer/hub/hub.css`, change `.conn-tile` to a horizontal row and add the fixed logo geometry:

```css
.conn-tile {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 10px 12px;
  text-align: left;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  color: var(--text-strong);
  font: inherit;
}
.conn-logo {
  display: grid;
  place-items: center;
  flex: 0 0 42px;
  width: 42px;
  height: 42px;
  box-sizing: border-box;
  padding: 8px;
  border-radius: 9px;
  background: var(--surface-2);
  color: var(--muted);
  overflow: hidden;
}
.conn-logo svg,
.conn-logo img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.conn-logo-fallback {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.conn-tile-copy,
.conn-chosen-ident {
  display: flex;
  min-width: 0;
}
.conn-tile-copy {
  flex-direction: column;
  gap: 3px;
}
.conn-chosen-ident {
  align-items: center;
  gap: 10px;
}
```

Keep the existing hover, focus, label and blurb rules unchanged. Ensure `.conn-chosen-ident .conn-logo` retains the same 42 px block.

- [ ] **Step 6: Build and verify GREEN**

Run:

```bash
npm run build:ts
SMOKE_ARTIFACT_DIR=/tmp/ordinate-logo-green npm run smoke
```

Expected: all new logo assertions pass, all existing smoke assertions pass, and no renderer/CSP errors are reported.

- [ ] **Step 7: Capture and inspect both themes**

Add two temporary smoke screenshots while the picker is open, or use Playwright against the real app:

```ts
await win.screenshot({ path: '/tmp/ordinate-logo-green/data-sources-light.png' });
await win.evaluate(() => document.documentElement.dataset.theme = 'dark');
await win.screenshot({ path: '/tmp/ordinate-logo-green/data-sources-dark.png' });
```

Inspect both images. Confirm: all icon blocks align, no mark is clipped, descriptions wrap, fallback initials remain legible, focus remains visible, and the Redshift white-backed image looks intentional in dark mode. Remove any temporary screenshot-only code before committing; retain the behavioral smoke assertions.

- [ ] **Step 8: Run the complete verification set**

Run:

```bash
npm run build:ts
npm test
npm run smoke
git diff --check
```

Expected: TypeScript build succeeds; approximately 3,300 assertions pass; smoke passes without renderer errors; `git diff --check` prints nothing.

- [ ] **Step 9: Request approval and commit Task 2**

Propose this exact message and wait for approval:

```text
Add logos to data-source cards

Render official marks or accessible fallback badges across all connector
tiles and the selected-source header using the approved compact layout.
```

After approval:

```bash
git add renderer/hub/connections.ts renderer/hub/connections.js renderer/hub/index.html renderer/hub/hub.css scripts/smoke-app.ts scripts/smoke-app.js
git commit -m "Add logos to data-source cards" -m "Render official marks or accessible fallback badges across all connector tiles and the selected-source header using the approved compact layout."
```

---

### Task 3: Final branch review and handoff

**Files:**
- Review only: all files changed from `develop...HEAD`

**Interfaces:**
- Consumes: the complete data-source logo feature from Tasks 1–2.
- Produces: a verified feature branch ready for user-directed push/PR handling.

- [ ] **Step 1: Review the branch diff and asset size**

Run:

```bash
git diff --stat develop...HEAD
git diff --check develop...HEAD
du -h renderer/hub/assets/connectors/amazon-redshift.png assets/provider-icons.json
git status --short
```

Expected: only the approved spec, plan, icon pipeline, one Redshift asset, connector renderer/CSS/HTML, generated siblings and focused tests are changed; no whitespace errors; no `.superpowers/` or `.claude/projects/` files are staged.

- [ ] **Step 2: Re-run completion verification from a clean build**

Run:

```bash
npm run build
npm test
npm run smoke
```

Expected: every command exits 0 and smoke reports no renderer or CSP errors.

- [ ] **Step 3: Use the branch-finishing workflow**

Invoke `superpowers:finishing-a-development-branch`. Do not merge. Offer the user the repo-supported next action (keep the branch, or push and open a PR targeting `develop`) and follow their choice. If opening a PR, use the Ordinate helper and verify its base is `develop`; the stale helper text mentioning `main` does not override `AGENTS.md` or `CLAUDE.md`.
