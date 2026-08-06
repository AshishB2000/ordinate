# Complete Source Logos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give all 35 catalog connectors real local marks and replace the Home → Connect blue squares with source/action icons.

**Architecture:** Keep `src/icons.ts` as the one main-process logo map. Existing Simple Icons remain in the committed generated JSON; missing brands and action icons are local SVG/PNG files auto-discovered into structured-clone-safe `data:` URIs. A shared renderer helper paints both the connector catalog and Home shortlist.

**Tech Stack:** TypeScript, vanilla DOM/CSS, Electron IPC/contextBridge, Playwright Electron smoke tests, existing `simple-icons` devDependency.

## Global Constraints

- All 35 live `connectorCatalog()` IDs resolve to a non-empty SVG path or local `data:` image URI.
- Normal UI shows zero initial badges; initials remain only for a corrupt image.
- No runtime dependency and no renderer network request.
- Hub CSP stays unchanged; no inline `style=` attributes.
- All marks are decorative because adjacent text is the accessible name.
- Manually bundled assets retain their proportions and colors and receive provenance notes.
- Do not stage or modify `.claude/projects/` or `.superpowers/`.
- Do not commit implementation until the exact final title and body are shown to the user and approved.

---

## File map

- `scripts/test-icons.ts`: executable 35-of-35 coverage boundary.
- `renderer/hub/assets/connectors/`: local vendor, format, and Home action assets.
- `renderer/hub/assets/connectors/SOURCES.md`: source URL, retrieval date, original filename, and terms note for each manual asset.
- `src/icons.ts`: unchanged asset-discovery boundary unless a source requires an explicit generated mapping.
- `renderer/hub/connections.ts`: shared logo constructor accepting an ID and label.
- `renderer/hub/index.html`: Home logo hosts replacing `.as-dot` spans.
- `renderer/hub/projects.ts`: fills Home logo hosts from the shared helper.
- `renderer/hub/hub.css`: compact Home logo slot and removal of dot styles.
- `scripts/smoke-app.ts`: real-renderer assertions for catalog and Home coverage.

---

### Task 1: Make missing catalog logos fail loudly

**Files:**
- Modify: `scripts/test-icons.ts`
- Read: `src/connectors/index.ts`
- Read: `src/icons.ts`

**Interfaces:**
- Consumes: `connectorCatalog(): ConnectorCatalogDef[]`, `connectorLogos: Record<string, BrandGlyph | BrandImage>`
- Produces: an executable assertion that returns a literal list of missing connector IDs and exits non-zero when it is non-empty.

- [ ] **Step 1: Add the failing coverage check**

Import the live registry and derive IDs independently from the logo map:

```ts
const { connectorCatalog } = require('../src/connectors') as {
  connectorCatalog: () => { id: string }[];
};

const catalogIds = connectorCatalog().map((d) => d.id);
const missing = catalogIds.filter((id) => {
  const logo = logos[id];
  return !(typeof logo?.path === 'string' && logo.path.length > 20) &&
    !(typeof logo?.src === 'string' && logo.src.startsWith('data:image/'));
});

ok('catalog exposes exactly 35 unique connector ids',
  catalogIds.length === 35 && new Set(catalogIds).size === 35,
  JSON.stringify(catalogIds));
ok('all 35 catalog connectors resolve to real marks',
  missing.length === 0,
  JSON.stringify(missing));
```

Also assert that no `logo.src` begins with `http:`, `https:`, or `file:`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run build:ts && node scripts/test-icons.js`

Expected: FAIL only for the coverage check, listing these 12 IDs:

```text
yugabytedb, materialize, questdb, risingwave, aurora-mysql, sqlserver,
oracle, azure-sql, azure-synapse, oracle-autonomous, starrocks, csv-folder
```

If the list differs, reconcile it against the live catalog before adding assets.

---

### Task 2: Bundle the 12 missing source marks

**Files:**
- Create: `renderer/hub/assets/connectors/yugabytedb.png`
- Create: `renderer/hub/assets/connectors/materialize.png`
- Create: `renderer/hub/assets/connectors/questdb.png`
- Create: `renderer/hub/assets/connectors/risingwave.png`
- Create: `renderer/hub/assets/connectors/aurora-mysql.svg`
- Create: `renderer/hub/assets/connectors/sqlserver.svg`
- Create: `renderer/hub/assets/connectors/oracle.svg`
- Create: `renderer/hub/assets/connectors/azure-sql.svg`
- Create: `renderer/hub/assets/connectors/azure-synapse.svg`
- Create: `renderer/hub/assets/connectors/oracle-autonomous.svg`
- Create: `renderer/hub/assets/connectors/starrocks.png`
- Create: `renderer/hub/assets/connectors/csv-folder.svg`
- Create: `renderer/hub/assets/connectors/SOURCES.md`
- Modify: `renderer/hub/connections.ts`

**Interfaces:**
- Consumes: `src/icons.ts` filename contract `<logo-id>.svg|png`.
- Produces: local `data:` entries in `connectorLogos` for the 12 missing catalog IDs, plus inline `currentColor` action glyphs for `home-paste` and `home-capture`.

- [ ] **Step 1: Acquire first-party assets**

Use the current official sources below and store only the smallest recognizable
mark, without wordmark padding when a product icon is available:

| Local IDs | Official source |
|---|---|
| `aurora-mysql` | `https://aws.amazon.com/architecture/icons/` — current AWS Architecture Icons package, Amazon Aurora service SVG |
| `azure-sql`, `azure-synapse`, `sqlserver` | `https://learn.microsoft.com/en-us/azure/architecture/icons/` and Microsoft SQL Server product documentation — current official SVG product icons |
| `oracle`, `oracle-autonomous` | `https://www.oracle.com/database/` and `https://www.oracle.com/autonomous-database/` — current product artwork used to identify the matching connector |
| `yugabytedb` | `https://github.com/yugabyte.png?size=256` — official organization avatar |
| `materialize` | `https://github.com/MaterializeInc.png?size=256` — official organization avatar |
| `questdb` | `https://github.com/questdb.png?size=256` — official organization avatar |
| `risingwave` | `https://github.com/risingwavelabs.png?size=256` — official organization avatar |
| `starrocks` | `https://github.com/StarRocks.png?size=256` — official organization avatar |

For `csv-folder.svg`, create a neutral file/document mark with the literal
letters `CSV`; CSV has no vendor. Define `home-paste` and `home-capture` as
simple inline 24×24 action pictograms using `currentColor`, so they inherit the
Home theme instead of being isolated inside an image document.

Do not copy HTML, scripts, tracking pixels, favicons for unrelated products, or
remote URLs into the renderer.

- [ ] **Step 2: Record provenance**

In `SOURCES.md`, add one row per manually acquired asset with:

```markdown
| Local file | Identifies | Official source URL | Retrieved | Original file/name | Notes |
```

Use `2026-08-06` as the retrieval date. State that trademarks remain property
of their owners and are used only for connector identification.

- [ ] **Step 3: Validate every asset**

Run:

```bash
file renderer/hub/assets/connectors/*
rg -n "<script|javascript:|https?://|file:" renderer/hub/assets/connectors/*.svg
```

Expected: PNGs are valid images; SVGs are standalone SVG XML; the security scan
returns no matches. Remove metadata and external references, but do not distort
paths, colors, or aspect ratios.

- [ ] **Step 4: Run focused test and verify GREEN**

Run: `npm run build:ts && node scripts/test-icons.js`

Expected: PASS, including `all 35 catalog connectors resolve to real marks`.

---

### Task 3: Make the Home shortlist use the shared logo pipeline

**Files:**
- Modify: `scripts/smoke-app.ts`
- Modify: `renderer/hub/connections.ts`
- Modify: `renderer/hub/index.html`
- Modify: `renderer/hub/projects.ts`
- Modify: `renderer/hub/hub.css`

**Interfaces:**
- Produces: `connMakeLogoFor(id: string, label: string): HTMLElement`
- Consumes in picker: `connMakeLogoFor(d.id, d.label)`
- Consumes on Home: `.as-source-logo[data-logo-id][data-logo-label]`

- [ ] **Step 1: Add failing real-renderer assertions**

Immediately after Home is visible in `scripts/smoke-app.ts`, evaluate:

```ts
const homeLogos = await page.evaluate(() => {
  const hosts = [...document.querySelectorAll('.as-connect-item .as-source-logo')];
  return {
    count: hosts.length,
    allDrawn: hosts.every((el) => !!el.querySelector('svg, img')),
    oldDots: document.querySelectorAll('.as-connect-item .as-dot').length,
    postgresSvg: !!document.querySelector(
      '.as-source-logo[data-logo-id="postgres"] svg',
    ),
    mysqlSvg: !!document.querySelector(
      '.as-source-logo[data-logo-id="mysql"] svg',
    ),
  };
});
```

Assert `count === 5`, `allDrawn === true`, `oldDots === 0`, and both database
SVG checks are true.

- [ ] **Step 2: Run smoke test and verify RED**

Run: `npm run smoke`

Expected: FAIL at `Home Connect shortcuts use five real source/action marks`
because the current markup has five `.as-dot` elements and no logo hosts.

- [ ] **Step 3: Extract the minimal shared constructor**

In `renderer/hub/connections.ts`, move the current `connMakeLogo` body to:

```ts
function connMakeLogoFor(id: string, label: string): HTMLElement {
  // Existing image, SVG, and corrupt-image fallback behavior, using
  // CONN_LOGOS[id] and connInitials(label).
}

function connMakeLogo(d: ConnDef): HTMLElement {
  return connMakeLogoFor(d.id, d.label);
}
```

Do not create a new module or dependency. Classic scripts resolve this global at
call time after all hub scripts have loaded.

- [ ] **Step 4: Replace Home dots with logo hosts**

In `renderer/hub/index.html`, replace each `.as-dot` with:

```html
<span class="as-source-logo" data-logo-id="csv-folder" data-logo-label="CSV / Excel" aria-hidden="true"></span>
```

Use IDs `csv-folder`, `home-paste`, `postgres`, `mysql`, and `home-capture` for
the five buttons respectively. Keep all button labels and `data-source` values
unchanged.

- [ ] **Step 5: Fill the Home hosts**

Add this to `renderer/hub/projects.ts` and call it at the start of `initHome()`:

```ts
function fillHomeSourceLogos(): void {
  document.querySelectorAll<HTMLElement>('.as-source-logo[data-logo-id]').forEach((host) => {
    const id = host.dataset.logoId || '';
    const label = host.dataset.logoLabel || '';
    const logo = connMakeLogoFor(id, label);
    host.replaceChildren(...logo.childNodes);
    host.setAttribute('aria-hidden', 'true');
  });
}
```

- [ ] **Step 6: Add compact Home styling**

Replace obsolete `.as-dot`/`.as-dot-*` rules with a fixed slot:

```css
.as-source-logo {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
  color: var(--muted);
}
.as-source-logo svg,
.as-source-logo img {
  display: block;
  width: 18px;
  height: 18px;
  object-fit: contain;
}
```

Do not add a background tile or change row height/click targets.

- [ ] **Step 7: Run build, lint, and smoke test; verify GREEN**

Run:

```bash
npm run build:ts
npm run lint
npm run smoke
```

Expected: all pass; Home reports five drawn marks and zero old dots.

---

### Task 4: Tighten the catalog smoke boundary and visually verify

**Files:**
- Modify: `scripts/smoke-app.ts`

**Interfaces:**
- Consumes: rendered `.conn-tile`, `.conn-logo`, `.conn-logo-fallback`, and selected-source header.
- Produces: real-app protection against any connector silently reverting to initials.

- [ ] **Step 1: Strengthen the existing catalog assertion**

Extend the current 35-tile evaluation to return:

```ts
const fallbackIds = tiles
  .filter((tile) => tile.querySelector('.conn-logo-fallback'))
  .map((tile) => (tile as HTMLElement).dataset.connectorId || '');
const undrawnIds = tiles
  .filter((tile) => !tile.querySelector('.conn-logo svg, .conn-logo img'))
  .map((tile) => (tile as HTMLElement).dataset.connectorId || '');
```

Assert both literal arrays are empty. Add representative checks for
`azure-sql`, `oracle`, `starrocks`, and `csv-folder`, while preserving Redshift,
PostgreSQL, selection-header, corrupt-image fallback, and accessibility checks.

- [ ] **Step 2: Prove the strengthened assertion catches a regression**

Temporarily rename one local asset outside the discovered extension, rebuild,
and run `node scripts/test-icons.js`. Expected: FAIL naming that connector ID.
Restore the filename before continuing. This is a test mutation, not a source
change; do not commit the temporary rename.

- [ ] **Step 3: Run the real app and capture light/dark screenshots**

Run `npm run smoke`, preserving screenshots for Home and the complete source
catalog. Inspect both themes for clipped wordmarks, low contrast, inconsistent
padding, or stretched aspect ratios. Fix only asset-specific sizing through the
asset viewBox or a narrowly scoped CSS class; do not change the card layout.

- [ ] **Step 4: Run final verification**

Run:

```bash
npm run build:ts
node scripts/test-icons.js
npm run lint
npm run smoke
git diff --check
```

Then run `npm test`. If the known timing-sensitive DuckDB suite fails inside the
aggregate run, run `node --test scripts/test-duckdb.js` separately and report
both results exactly; do not hide or relabel the aggregate failure.

- [ ] **Step 5: Propose one implementation commit**

Show the user this exact message and wait for approval:

```text
Complete logos for every data source

Bundle source-specific marks for all 35 connectors and reuse the logo
pipeline for the Home Connect shortcuts, with coverage and smoke checks.
```

After approval, stage only the plan, source/logo assets, provenance note,
renderer changes, and tests. Exclude `.claude/projects/` and `.superpowers/`.
