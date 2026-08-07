# Vector App Logo and Screenshot Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the screenshot-like Ordinate app artwork with the approved exact vector reconstruction and use the supplied Screenchart PNG for the Home Screenshot source.

**Architecture:** Keep `assets/icons/ordinate.svg` and `assets/icons/mark.svg` as native vector sources. Restore the existing dependency-free Electron app-icon builder so packaged and renderer PNGs are deterministically generated, then route the Home action through the existing `ConnLogo.src` image path.

**Tech Stack:** SVG, PNG, Electron `BrowserWindow.capturePage`, Node.js standard library, TypeScript renderer, Node self-checks, Playwright Electron smoke test.

## Global Constraints

- Preserve the approved faceted frame, darker left face, three bars, and open bottom split.
- Keep the outer canvas transparent and the mark horizontally centered.
- Save native SVG and generated PNG assets under the project assets.
- Remove the obsolete raster source and every embedded raster from the Ordinate SVG sources.
- Bundle the supplied Screenchart icon locally; no renderer network or filesystem URL.
- Add no runtime dependency.
- Keep the strict hub CSP and decorative accessibility behavior unchanged.
- Do not rename the Electron product or change user-data paths.

---

### Task 1: Pin the new asset contract

**Files:**
- Modify: `scripts/test-icons.ts`
- Test: `scripts/test-icons.ts`

**Interfaces:**
- Consumes: existing Node `fs`/`path` APIs and the connector-logo contract.
- Produces: asset assertions that fail for embedded rasters, missing generated files, or stale Home Screenshot wiring.

- [ ] **Step 1: Add failing vector and PNG assertions**

Read the two SVG sources and assert they contain paths but no `<image>`, `data:image`, `http:`, or `file:` references. Assert `ordinate.svg` contains the centered tile coordinates `x="100"`, `width="824"`, and the existing traced mark path. Assert the obsolete reference PNG is absent.

Add a PNG header helper and assert `assets/icons/icon.png` is 1024×1024 and `renderer/hub/assets/connectors/screenchart.png` is 1024×1024:

```ts
function pngSize(file: string): { width: number; height: number } | null {
  const buf = fs.readFileSync(file);
  if (buf.subarray(1, 4).toString('ascii') !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
```

Read `renderer/hub/connections.ts` and assert `home-capture` uses
`src: 'assets/connectors/screenchart.png'` rather than the generic capture path.

- [ ] **Step 2: Run the focused test and verify red state**

Run: `npm run build:ts && node --test --test-reporter=spec scripts/test-icons.js`

Expected: FAIL because the current light/mark SVGs embed PNG data, the obsolete
reference still exists, the Screenchart asset is absent, and Home still uses an
SVG action path.

---

### Task 2: Replace the raster icon source and restore generation

**Files:**
- Modify: `.gitignore`
- Create: `scripts/build-appicon.js`
- Modify: `assets/icons/ordinate.svg`
- Modify: `assets/icons/mark.svg`
- Modify: `assets/icons/ordinate-dark.svg`
- Modify: `assets/icons/README.md`
- Delete: `assets/icons/reference/cube-insight-200.png`
- Regenerate: `assets/icons/icon.png`
- Regenerate: `assets/icons/icon.icns`
- Regenerate: `assets/icons/icon.ico`
- Regenerate: `renderer/hub/logo-tile.png`
- Regenerate: `renderer/hub/logo.png`
- Test: `scripts/test-icons.ts`

**Interfaces:**
- Consumes: the traced `d` path and `hex` gradient already present in `ordinate-dark.svg`.
- Produces: `npm run build:appicon`, native SVG sources, packaged icons, and refreshed renderer PNGs.

- [ ] **Step 1: Track the existing app-icon builder**

Add this exception after `scripts/**/*.js` in `.gitignore`:

```gitignore
!/scripts/build-appicon.js
```

Restore the existing local `scripts/build-appicon.js` implementation. Keep its
shell-free `execFileSync('iconutil', [...])`, transparent `BrowserWindow`,
single-window rendering, hand-written ICO container, and explicit failures.

- [ ] **Step 2: Extend the builder for renderer copies**

Keep one `BrowserWindow` alive while loading both SVG sources. Render the light
tile source at the existing app sizes plus 200px, and the bare mark at 160px.
Write:

```js
fs.writeFileSync(path.join(ROOT, 'renderer', 'hub', 'logo-tile.png'), lightPngs.get(200));
fs.writeFileSync(path.join(ROOT, 'renderer', 'hub', 'logo.png'), markPngs.get(160));
```

The capture page must remain transparent so the tile corners do not become a
white rectangle.

- [ ] **Step 3: Replace the SVG sources**

Build `ordinate.svg` from the exact traced path in `ordinate-dark.svg` with:

```svg
<rect x="100" y="100" width="824" height="824" rx="184"
      fill="#f7f9fc" stroke="#d8dee8" stroke-width="8"/>
```

Keep the existing `hex` gradient and traced path unchanged. Build `mark.svg`
from the same gradient and path without a tile. Keep `ordinate-dark.svg` as the
dark-tile variant and update its comments so the deleted raster is historical
provenance, not an active source.

- [ ] **Step 4: Remove stale raster documentation and source**

Delete `assets/icons/reference/cube-insight-200.png`. Update
`assets/icons/README.md` to name `ordinate.svg`/`mark.svg` as vector sources,
remove the 200px softness limitation, document transparent corners, and list
the two renderer PNGs among generated outputs.

- [ ] **Step 5: Regenerate every icon artifact**

Run: `npm run build:appicon`

Expected: successful renders at all configured sizes; new `icon.png`, `.icns`,
`.ico`, `logo-tile.png`, and `logo.png` written.

- [ ] **Step 6: Run the focused test**

Run: `npm run build:ts && node --test --test-reporter=spec scripts/test-icons.js`

Expected: only the not-yet-wired Home Screenshot assertion remains red.

---

### Task 3: Use the Screenchart asset on Home

**Files:**
- Create: `renderer/hub/assets/connectors/screenchart.png`
- Modify: `renderer/hub/connections.ts`
- Modify: `scripts/smoke-app.ts`
- Test: `scripts/test-icons.ts`
- Test: `scripts/smoke-app.ts`

**Interfaces:**
- Consumes: `ConnLogo.src` and `connMakeLogoFor(id, label)`.
- Produces: a local image mark for `home-capture` with the existing error fallback.

- [ ] **Step 1: Bundle the supplied source image**

Copy `/Users/ashishb/Projects/screenchart/assets/icons/icon.png` byte-for-byte to
`renderer/hub/assets/connectors/screenchart.png`.

- [ ] **Step 2: Route Home Screenshot through the image path**

Replace only the `home-capture` action entry:

```ts
'home-capture': {
  src: 'assets/connectors/screenchart.png',
  title: 'Screenshot',
},
```

Do not change the button label, `data-source="capture"`, helper, fallback, or
accessibility attributes.

- [ ] **Step 3: Update real-app smoke coverage**

Replace the combined `actionSvgs` check with separate assertions:

```ts
pasteSvg: !!document.querySelector(
  '.as-source-logo[data-logo-id="home-paste"] svg path[fill="currentColor"]',
),
captureImg: document.querySelector(
  '.as-source-logo[data-logo-id="home-capture"] img',
)?.getAttribute('src') === 'assets/connectors/screenchart.png',
```

Require both values in the existing Home logo assertion.

- [ ] **Step 4: Run focused checks**

Run: `npm run build:ts && node --test --test-reporter=spec scripts/test-icons.js`

Expected: PASS.

---

### Task 4: Verify the complete change and prepare the approved commit

**Files:**
- Verify all files from Tasks 1–3.
- Include: `docs/superpowers/plans/2026-08-06-vector-app-logo-and-screenshot-source.md`

**Interfaces:**
- Consumes: generated assets and renderer wiring from Tasks 1–3.
- Produces: evidence that the implementation is safe to commit and merge.

- [ ] **Step 1: Inspect generated visuals**

Open `assets/icons/icon.png`, `renderer/hub/logo-tile.png`,
`renderer/hub/logo.png`, and the Screenchart connector PNG. Verify transparent
corners, equal side spacing, sharp vector-derived edges, preserved faceting,
preserved bottom split, and readable small-size marks.

- [ ] **Step 2: Run build and focused tests**

Run:

```bash
npm run build:appicon
npm run build:ts
node --test --test-reporter=spec scripts/test-icons.js
```

Expected: every command exits 0.

- [ ] **Step 3: Run the full suite**

Run: `npm test`

Expected: 64 test files pass. If the localhost connector test is sandbox-blocked,
rerun it outside the sandbox; do not treat `listen EPERM` as a product failure.

- [ ] **Step 4: Run the real app smoke test**

Run: `npm run smoke`

Expected: all smoke assertions pass with no renderer or CSP errors, including
the Screenchart image on Home in light and dark themes.

- [ ] **Step 5: Review the final diff**

Run: `git diff --check`, `git status --short`, and inspect the exact binary file
list. Confirm no downloaded GeoJSON placeholders, build output, session files,
or unrelated user changes are included.

- [ ] **Step 6: Request commit-message approval**

Propose one implementation commit with this message and wait for approval:

```text
Replace the app logo with native vector artwork

Preserve the faceted Ordinate mark in scalable assets and refresh every
packaged icon. Use the bundled Screenchart image for the Home capture source.
```

After approval, stage only the planned files and commit without a co-author
trailer.
