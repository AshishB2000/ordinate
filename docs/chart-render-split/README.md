# chartRender.ts — the parameter-object split

`renderer/hub/chartRender.ts` was **999 lines against an 800 cap**, the largest
entry in `scripts/test-file-size.ts`'s shrinking allowlist. Its own header said
why it had survived, and what the fix was:

> buildChart() is ONE 870-line function and every per-chart-family block reads
> its locals (palette, fmt, isRound, makeValueAxis, …). Breaking it up means
> inventing a parameter object, which is a design change with real behaviour
> risk, not a move. Own PR.

This is that PR. **999 → 336 lines**, and the allowlist entry is **removed**, not
lowered — the list may only shrink.

## The parameter object

`ChartCtx` (declared in `chartRender.ts`, next to `ChartSeriesShape`) carries the
locals every family block used to read off `buildChart`'s stack: the resolved
type spec, the data, the overrides, the formatter, and the theme tokens read off
this canvas. It is assembled **once**, and each family module destructures it
back into **the same local names** — so the blocks are the code they always were,
in files named for what they build.

| file | lines | job |
| --- | ---: | --- |
| `chartRender.ts` | 336 | assemble `ChartCtx`, the tooltip, and the Chart.js config |
| `chartTypeSpec.ts` | 90 | chart id → Chart.js type + option flags + the `is*` traits |
| `chartValueLabels.ts` | 279 | which points get labelled, and the plugins that draw them |
| `chartDatasets.ts` | 349 | the per-family Chart.js dataset shapes, and the gradients |
| `chartScales.ts` | 138 | the per-family axis sets, start-at-zero, axis titles |

Every file is under the 500-line smell line.

The three family modules run in a **fixed order** and it is not cosmetic:
`buildChartDatasets` writes per-family state onto `opts` (`_gaugeValue`,
`_matrixCols`/`_matrixGrid`, `_funnelMax`/`_funnelVals`) that `buildChartScales`
and `buildChartPlugins` then read back.

The renderer split ritual, all four steps: new `renderer/hub/<name>.ts` →
`<script src>` in `index.html` in dependency order (`chartTypeSpec` →
`chartValueLabels` → `chartDatasets` → `chartScales` → `chartRender`) → emitted
`.js` in `.gitignore`. **No `globals.d.ts` entries**: these are top-level
declarations in the shared renderer program, which `globals.d.ts`'s own NOTE says
must not be double-declared (TS2451).

Public API is unchanged. `buildChart(canvas, data, type, overrides)` keeps its
name, signature and return, so `renderResult.ts`, `vizThumbs.ts`, `chartControls.ts`
and the export paths are untouched.

## The colour-read bug, deliberately preserved

`getComputedStyle` on a **detached** element returns `''` for every custom
property, so a chart drawn before its container is in the document would silently
fall back to Chart.js's built-in `#666`. The theme reads therefore stay **inside**
`buildChart`, at the point they were, and the code now says so in a comment. They
were not hoisted to module scope, and `chartDatasets`'s own `--accent` / `--ok` /
`--error` reads stay inside the function that needs them.

## How this was made safe: scripts/test-chartSpec.ts

Written **before** a line of `chartRender.ts` moved. The Chart.js **config
object** is a pure function of `(data, type, overrides)` plus the theme tokens,
so it can be captured exactly:

- the emitted siblings are executed in a `vm` sandbox (the `test-plotSpec.ts`
  pattern) with a **recording stand-in for the Chart.js constructor** — so the
  real functions build the real config, and no DOM, no Electron and no Playwright
  are involved;
- every stub is deterministic: a fixed theme-token table for `getComputedStyle`,
  `prefers-reduced-motion: false`, and hub.js's formatters restated without
  `toLocaleString()` (locale- and ICU-dependent);
- each config is serialised with **keys sorted and functions kept as source
  text** — so a plugin's `afterDatasetsDraw` body, an axis tick callback and a
  scriptable gradient are all inside the comparison — then hashed;
- `GOLDEN` is those hashes, taken from **develop before the split**;
- **all 28 chart ids in `VIZ_LABELS` × 3 override sets = 84 cases**, and all 84
  round-tripped identically. `table`, `map_bubble` and `map_choropleth` are never
  routed to `buildChart` by the app, so what they capture is its `default:`
  branch; they are included because that branch is real code the split must not
  move either.

Function sources are compared with **per-line indentation stripped**. Leading
whitespace is never semantic in JavaScript, and moving a function out of
`buildChart` into a sibling module changes exactly that and nothing else (tsc
emits it at a shallower depth). Everything that *is* semantic — identifiers,
operators, string contents, which locals a closure names — still has to match.
Before that normalisation the 84 raw serialisations differed **only** in leading
whitespace, which was verified pairwise before the golden table was written.

The suite also refuses to pass green and inert: it asserts that a config was
actually recorded for every case (a `null` chart fails loudly rather than
comparing 84 identical hashes of nothing) and that the captures are distinct per
chart id. `ORDINATE_CHARTSPEC_DUMP=<dir>` writes every serialisation out, so a
deliberate future change is diffable rather than two opaque hashes.

## Gates

```
npm run build:ts                  clean
npm run lint                      oxlint, zero findings
npm test                          105 suites pass (incl. test-chartSpec: 88 ok, 0 fail)
node scripts/smoke-dashboards.js       pass, 0 renderer console errors
node scripts/smoke-dashboard-styles.js pass, 0 renderer console errors
node scripts/smoke-viz-thumbs.js       pass, 0 renderer console errors
```

## Evidence

Real app, fresh `--user-data-dir`, the bundled sample project, light and dark,
`before` = `488b63e` (this branch's base) in a scratch worktree:

- `before/after-dashboard-{light,dark}.png` — the sample's "Retail overview":
  four KPI tiles, the line, the column chart with its value labels, the region
  map.
- `before/after-gallery-{light,dark}.png` — the Visuals gallery's live
  thumbnails (bar + line drawn, map keeping its glyph).

Pixel-identical apart from the "Data as of HH:MM" clock the two runs were taken
at. **Zero renderer console errors in both runs, both themes.**
