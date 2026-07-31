# US Geographic Choropleth Levels — Design

**Date:** 2026-06-16
**Status:** Approved (pending spec review)

## Problem

Capturing a list of Virginia counties/cities produces a **blank global map**. The app
labels it a "Virginia Choropleth Map" but renders the world-countries layer zoomed to the
whole globe, with every region "No data" and a *"Couldn't place: …"* note listing all
items.

Root cause: the app supports only three geo levels — `country`, `us_state`, `point`
([src/analyze.js](../../../src/analyze.js)) — and only two boundary datasets,
world-countries and US-states ([renderer/hub/hub.js](../../../renderer/hub/hub.js)
`_renderChoroplethMap`). Sub-state data (counties, cities, ZIPs) has no level, so the model
tags it `country`, the renderer falls through to `__GEO_WORLD__`, nothing matches, and the
map fits to the world.

## Goal

Add filled-polygon choropleth support for US **state, county, city, and ZIP** levels, keep
the existing world-countries level, and make any unsupported/unmatched case degrade
gracefully to a bubble map or bar chart instead of a blank globe.

International subdivisions (provinces, intl cities/postcodes) are explicitly **out of scope
for this phase** — most of that data (esp. worldwide postcodes) is not openly sourceable.
This is Phase 1 of a possible larger effort.

## Non-Goals

- International admin levels (provinces, intl cities, intl postcodes).
- City/ZIP rendered as anything other than filled polygons (user chose polygons over bubbles).
- Persisting downloaded geo data anywhere other than the existing `assets/geo/` build output.

## Design

### 1. Geo levels & data model

Allowed `geo.level` values become:
`country`, `us_state`, `us_county`, `us_city`, `us_zip`, `point`.

Each geo item gains two optional fields, required for US sub-state levels:

```json
{ "name": "Stafford", "state": "Virginia", "value": 170803, "kind": "county" }
```

- `state` — full state name (e.g. "Virginia"). **Required** for `us_county`, `us_city`,
  `us_zip`. Ignored for `country`, `us_state`, `point`. Needed because county/city names are
  not unique nationally (e.g. multiple "Roanoke"s).
- `kind` — `"county"` | `"city"`. Lets a single capture mix counties **and** independent
  cities. This is essential for Virginia, where independent cities (Newport News,
  Alexandria, Hampton, Suffolk, …) live in the **city/places** boundary set, not the county
  set. The renderer loads both sets and resolves each item to the right one via `kind`.
- For `us_zip`, `name` is the ZCTA code itself (e.g. `"22554"`); matched directly.

### 2. Data sources, build script & size strategy

Extend [scripts/download-geo.js](../../../scripts/download-geo.js) `SOURCES` with three new
entries, following the existing pattern (download → `pickProps` → coord-round → write
asset). Public-domain Census/Natural Earth sources.

| Level | Source | ~Features | Props kept |
|---|---|---|---|
| `us_county` | Census/TIGER simplified counties | ~3,100 | `name`, `state`, `fips` |
| `us_city` | Census "places" (cities/towns; includes VA independent cities) | ~30,000 | `name`, `state` |
| `us_zip` | Census ZCTA simplified | ~33,000 | `zip`, `state` |

Size mitigation (these files are large):
- **Per-level coordinate precision**: keep `COORD_DECIMALS = 2` (~1km) for county; use a
  coarser `1` (~10km) for city and ZIP since they render small on screen. Implement as a
  per-source `coordDecimals` override (default 2).
- **Prefer pre-simplified sources** so we don't ship full-resolution TIGER.
- Expected bundle: county ~2–4MB, city ~8–15MB, ZIP ~15–30MB.

The build keeps a `state` property on every county/city/ZIP feature (the matcher needs it).

Graceful sourcing: the script already writes an empty `FeatureCollection` placeholder when a
download fails, so the app still loads. The Section 4 fallback turns "empty data for this
level" into a bubble/bar chart rather than an error.

### 3. Lazy loading (architecture change)

Heavy levels must not be eager-loaded at startup. Currently
[renderer/hub/index.html](../../../renderer/hub/index.html) loads each geo file via a
`<script>` tag before the app runs — fine for world (~400KB) + states, fatal for 30MB of ZIP
data on every launch.

New approach:
- `us_county`, `us_city`, `us_zip` are written as plain `.json` files in `assets/geo/`
  (not `.js` globals), and are **not** in `<script>` tags.
- When `_renderChoroplethMap` needs a level, it calls
  `await window.hub.loadGeo(level)` → IPC `geo:load` → main reads
  `assets/geo/<level>.json` from disk, parses, and returns it. Main caches parsed results
  per level, so subsequent maps of the same level are instant.
- IPC (not `fetch`) because the hub CSP is `default-src 'none'`, which blocks `fetch`.
- World + states stay eager (small, already working) — leave them unchanged to minimize risk.
- The map shows a small loading state while the file reads.

New surface:
- IPC: `geo:load` (`ipcMain.handle`, renderer → main, returns parsed GeoJSON or empty
  `FeatureCollection`).
- Preload: `loadGeo: (level) => ipcRenderer.invoke('geo:load', level)` in
  [preload/hubPreload.js](../../../preload/hubPreload.js).
- Main validates `level` against a whitelist before building the file path (no arbitrary
  path reads).

### 4. Name matching & fallback chain

**Matching** (`matchGeoItem` / `normalizeName` in hub.js):
- Strip administrative suffixes when normalizing: "County", "Parish" (LA), "Borough" (AK),
  "City", "(City)", "Town". `"Stafford County"` → `stafford`, `"Newport News (City)"` →
  `newport news`.
- Match on the pair `(normalizedName, state)` so cross-state name collisions don't mismatch.
- For mixed captures, route each item by `kind`: `county` items matched against the county
  set, `city` items against the city/places set. (Independent cities exist only in the city
  set.)
- ZIP: match the ZCTA code string directly (optionally scoped by state).

**Fallback chain** — when a choropleth cannot render:
1. Level boundary data missing/empty → go to 3.
2. Zero items matched any polygon → go to 3.
3. Items have numeric `lat`/`lng` → render the existing **bubble map**.
4. Else → render a **bar chart** + an inline note ("Couldn't map these regions").

Hard rule: **a US level never silently falls back to the world-countries map.** `__GEO_WORLD__`
is used only for `country` level. This is the specific defect behind the Virginia bug.

### 5. Prompt & validation changes (`analyze.js`)

- Extend the allowed `geo.level` list and describe each level and when to pick it (county
  names → `us_county`, ZIP codes → `us_zip`, US states → `us_state`, countries → `country`,
  lat/lng points → `point`).
- Require `state` (full name) and `kind` (`county`|`city`) on every item for
  `us_county`/`us_city`/`us_zip`. For a mixed VA counties+cities capture, each row is tagged
  individually.
- Validation mirrors the prompt: accept the new levels, retain `state`/`kind` when present,
  drop malformed items — same defensive style as the current `country|us_state|point` check.

### 6. Testing

No test framework is wired yet (per CLAUDE.md). Add one runnable check for the riskiest pure
logic:
- **Matcher self-check** — a standalone `node` script (no Electron) that feeds a
  Virginia-like item list against a small inline fixture of county + city features and
  asserts: "Newport News" resolves in the **city** set, "Stafford" in the **county** set,
  and a "Roanoke" item resolves by `kind` to county vs city correctly. Requires the matcher
  to be importable as a pure function (extract `normalizeName`/`matchGeoItem` so they can be
  required outside the renderer, or duplicate the small fixture-test inline).
- **Manual** — re-run the Virginia screenshot: expect a Virginia-fitted map with counties +
  independent cities shaded, not a blank globe.

## Risks / Open Questions

- **Exact source URLs** for simplified county/city/ZCTA GeoJSON need verification at build
  time; if one 404s, the placeholder + fallback keep the app working but that level won't
  shade. Resolve during implementation.
- **Bundle size**: ZIP especially. If it proves too heavy even simplified, revisit
  (coarser precision, or defer `us_zip` to a follow-up). Lazy loading keeps startup fast
  regardless.
- **Matcher extraction**: making `matchGeoItem`/`normalizeName` testable may require a small
  refactor of hub.js to expose them; keep it minimal.

## Affected Files

- `scripts/download-geo.js` — add 3 sources + per-source coord precision.
- `assets/geo/` — new `us-county.json`, `us-city.json`, `us-zip.json` (build output, large).
- `src/analyze.js` — prompt + validation for new levels and `state`/`kind`.
- `renderer/hub/hub.js` — level→dataset routing, lazy `loadGeo`, matcher upgrade, fallback chain.
- `preload/hubPreload.js` — `loadGeo` method.
- `main.js` — `geo:load` IPC handler + per-level cache.
- `renderer/hub/index.html` — no new heavy `<script>` tags (lazy via IPC instead).
- New matcher self-check script.
